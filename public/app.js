const result = document.querySelector('#result');
const leads = document.querySelector('#leads');
const readiness = document.querySelector('#readiness');
const searchResults = document.querySelector('#search-results');
const searchSummary = document.querySelector('#search-summary');
const sourceHealth = document.querySelector('#source-health');
let current = null;
let appState = null;
let refreshTimer = null;
let countdownTimer = null;
let searching = false;

document.querySelector('#verify').addEventListener('click', () => runVerification());
document.querySelector('#save-profile').addEventListener('click', saveProfile);
document.querySelector('#search-jobs').addEventListener('click', () => searchJobs());
document.querySelector('#search-top').addEventListener('click', () => {
  document.querySelector('#search').scrollIntoView({behavior: 'smooth'});
  searchJobs();
});
document.querySelector('#role-query').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') searchJobs();
});

async function saveProfile() {
  readiness.className = 'readiness';
  readiness.textContent = 'saving locally…';
  try {
    const data = await requestJson('/api/profile', {
      method: 'POST',
      body: JSON.stringify({
        targetRoles: list('#target-roles'),
        locations: list('#locations'),
        mustHaves: list('#must-haves'),
      }),
    });
    showProfile(data.profile, data.readiness);
    readiness.textContent = `${data.readiness.message} Saved locally.`;
  } catch (error) {
    readiness.className = 'readiness not-ready';
    readiness.innerHTML = `${escape(error.message)} <button class="button ghost" id="retry-profile">Retry</button>`;
    document.querySelector('#retry-profile').addEventListener('click', saveProfile);
  }
}

async function searchJobs({ silent = false } = {}) {
  if (searching) return;
  searching = true;
  clearRefreshTimers();
  const button = document.querySelector('#search-jobs');
  button.disabled = true;
  button.textContent = 'Scanning feeds…';
  if (!silent) {
    searchSummary.textContent = 'Reading company publishing feeds and comparing postings…';
    searchResults.innerHTML = loadingCards();
  }
  try {
    const data = await requestJson('/api/search', {
      method: 'POST',
      body: JSON.stringify(readSearchConfig()),
    });
    renderSearch(data);
    appState = {...appState, searchConfig: data.config, searchStatus: {lastRunAt: data.searchedAt}};
    scheduleRefresh(data.config);
  } catch (error) {
    searchSummary.textContent = 'Search failed. Nothing was added or marked live.';
    searchResults.innerHTML = `<div class="empty-state"><strong>${escape(error.message)}</strong><p>Retry the feeds or adjust the company list.</p><button class="button ghost" id="retry-search">Retry search</button></div>`;
    document.querySelector('#retry-search').addEventListener('click', () => searchJobs());
    document.querySelector('#next-refresh').textContent = 'auto-refresh paused after error';
  } finally {
    searching = false;
    button.disabled = false;
    button.textContent = 'Search published roles';
  }
}

function renderSearch(data) {
  const healthy = data.sources.filter((source) => source.ok).length;
  document.querySelector('#stat-open').textContent = data.total;
  document.querySelector('#stat-new').textContent = data.newCount;
  document.querySelector('#stat-sources').textContent = `${healthy}/${data.sources.length}`;
  document.querySelector('#last-scan').textContent = `last scan ${relativeTime(data.searchedAt)}`;
  searchSummary.textContent = data.outage
    ? 'Every configured source failed. No posting status was inferred.'
    : `${data.total} matching posting${data.total === 1 ? '' : 's'} · ${data.newCount} new after baseline · ${data.matchedCount || data.total} matched before display limit`;
  sourceHealth.innerHTML = data.sources.map((source) => `<span class="source-chip ${source.ok ? 'ok' : 'fail'}">${escape(source.name)} · ${source.ok ? `${source.count} published` : escape(source.error)}</span>`).join('');
  searchResults.innerHTML = data.outage
    ? '<div class="empty-state"><strong>All company feeds are unavailable.</strong><p>Nothing was called published or live. Retry later or inspect the source errors above.</p><button class="button ghost" id="retry-outage">Retry feeds</button></div>'
    : data.jobs.length
      ? data.jobs.map(jobCard).join('')
      : '<div class="empty-state"><strong>No matching postings in the current feeds.</strong><p>Try fewer title words, remove the location filter, or add another company board.</p></div>';
  document.querySelector('#retry-outage')?.addEventListener('click', () => searchJobs());
  searchResults.querySelectorAll('[data-verify-url]').forEach((button) => {
    button.addEventListener('click', () => runVerification(button.dataset.verifyUrl, {
      title: button.dataset.title,
      company: button.dataset.company,
      location: button.dataset.location,
      source: button.dataset.source,
      board: button.dataset.board,
      postedAt: button.dataset.postedAt,
      firstSeenAt: button.dataset.firstSeenAt,
    }));
  });
}

function jobCard(job) {
  const score = job.relevance?.score ?? 0;
  const age = job.postedAt ? relativeTime(job.postedAt) : 'date unavailable';
  return `<article class="job-card ${job.isNew ? 'new' : ''}" data-job-url="${escape(job.url)}">
    <div class="job-top"><span class="company">${escape(job.company)}</span><div class="badges">${job.isNew ? '<span class="badge new">new</span>' : ''}<span class="badge verification-badge">published · unverified</span></div></div>
    <h3>${escape(job.title)}</h3>
    <div class="job-meta">${escape(job.location)}<br>published ${escape(age)}</div>
    <div class="matchbar" aria-label="${score}% title match"><i style="width:${Math.max(3, Math.min(score, 100))}%"></i></div>
    <div class="match-copy">${score}% title match${job.relevance?.matched?.length ? ` · ${escape(job.relevance.matched.join(', '))}` : ''} · verification required</div>
    <div class="job-actions"><button class="button primary" data-verify-url="${escape(job.url)}" data-title="${escape(job.title)}" data-company="${escape(job.company)}" data-location="${escape(job.location)}" data-source="${escape(job.source)}" data-board="${escape(job.board)}" data-posted-at="${escape(job.postedAt)}" data-first-seen-at="${escape(job.firstSeenAt)}">Verify live</button><a class="text-link" href="${escape(job.url)}" target="_blank" rel="noreferrer">open source ↗</a></div>
  </article>`;
}

async function runVerification(discoveredUrl, metadata = {}) {
  const urlInput = document.querySelector('#job-url');
  if (discoveredUrl) urlInput.value = discoveredUrl;
  const url = urlInput.value.trim();
  current = null;
  document.querySelector('#verify-panel').scrollIntoView({behavior: 'smooth', block: 'center'});
  result.className = 'result inconclusive';
  result.innerHTML = '<p class="quiet">Following redirects and checking source evidence…</p>';
  try {
    current = await requestJson('/api/verify', {
      method: 'POST',
      body: JSON.stringify({url, ...metadata}),
    });
    renderResult(current);
  } catch (error) {
    renderRequestFailure(error.message, url);
  }
}

function renderResult(check) {
  updateJobCard(check);
  result.className = `result ${check.status || 'inconclusive'}`;
  result.innerHTML = `<div class="status">${escape(check.status || 'invalid request')}</div><strong>${escape(check.reason || check.error)}</strong><p class="why">${check.checkedAt ? `checked ${new Date(check.checkedAt).toLocaleString()}` : ''}${check.httpStatus ? ` · HTTP ${check.httpStatus}` : ''}${check.signals?.length ? `<br>signals: ${escape(check.signals.join(' + '))}` : ''}${check.finalUrl || check.url ? `<br>${escape(check.finalUrl || check.url)}` : ''}</p>`;
  if (check.status === 'live') {
    const save = document.createElement('button');
    save.className = 'button primary';
    save.textContent = 'Add to review queue';
    save.onclick = async () => {
      save.disabled = true;
      save.textContent = 'Saving…';
      let saved;
      try {
        saved = await requestJson('/api/leads', {
          method: 'POST',
          body: JSON.stringify({verificationId: current.verificationId}),
        });
      } catch (error) {
        const needsVerification = /verifier again/i.test(error.message);
        save.disabled = false;
        save.textContent = needsVerification ? 'Verify again' : 'Retry save';
        if (needsVerification) save.onclick = () => runVerification(current.finalUrl || current.url, current);
        result.insertAdjacentHTML('beforeend', `<p class="quiet">${escape(error.message)}</p>`);
        return;
      }
      save.textContent = saved.saved ? 'Queued' : 'Already queued';
      result.insertAdjacentHTML('beforeend', `<p class="quiet">${escape(saved.saved ? 'Saved to your verified review queue.' : saved.reason)}</p>`);
      await loadState({ autoSearch: false });
    };
    result.append(save);
  } else if (check.status === 'blocked' || check.status === 'inconclusive') {
    result.insertAdjacentHTML('beforeend', `<p class="quiet">Nothing was saved. Choose what happens next.</p>${actionMarkup(check.finalUrl || check.url)}`);
    wireOutcomeActions(check.finalUrl || check.url);
  }
}

function updateJobCard(check) {
  const card = [...document.querySelectorAll('.job-card')].find((item) => item.dataset.jobUrl === check.url);
  if (!card || !check.status) return;
  const badge = card.querySelector('.verification-badge');
  const verifyButton = card.querySelector('[data-verify-url]');
  badge.className = `badge verification-badge ${check.status}`;
  if (check.status === 'live') {
    badge.textContent = 'verified live';
    card.classList.add('verified');
  } else if (check.status === 'closed') {
    badge.textContent = 'verified closed';
    card.classList.add('closed');
    verifyButton.disabled = true;
    verifyButton.textContent = 'Closed';
  } else {
    badge.textContent = check.status === 'blocked' ? 'verification blocked' : 'not confirmed';
  }
}

function renderRequestFailure(message, url) {
  result.className = 'result inconclusive';
  result.innerHTML = `<div class="status">check failed</div><strong>${escape(message)}</strong><p class="quiet">Nothing was saved.</p>${actionMarkup(url)}`;
  wireOutcomeActions(url);
}

function actionMarkup(url) {
  const open = safeHttpUrl(url) ? `<a href="${escape(url)}" target="_blank" rel="noreferrer">open source ↗</a>` : '';
  return `<p><button class="button ghost" id="retry-check">Retry</button> ${open} <button class="button ghost" id="discard-check">Discard</button></p>`;
}

function wireOutcomeActions(url) {
  document.querySelector('#retry-check').addEventListener('click', () => runVerification(url));
  document.querySelector('#discard-check').addEventListener('click', () => {
    current = null;
    result.className = '';
    result.innerHTML = '<p class="quiet">Discarded. Nothing was saved.</p>';
  });
}

function showProfile(profile, state) {
  document.querySelector('#target-roles').value = profile.targetRoles.join(', ');
  document.querySelector('#locations').value = profile.locations.join(', ');
  document.querySelector('#must-haves').value = profile.mustHaves.join(', ');
  readiness.className = state.ready ? 'readiness ready' : 'readiness not-ready';
  readiness.textContent = state.message;
}

function showSearchConfig(config) {
  document.querySelector('#role-query').value = config.query;
  document.querySelector('#search-location').value = config.location;
  document.querySelector('#source-boards').value = config.boards.join(', ');
  document.querySelector('#auto-refresh').checked = config.autoRefresh;
  document.querySelector('#refresh-minutes').value = String(config.refreshMinutes);
}

function renderQueue(queue) {
  document.querySelector('#stat-queue').textContent = queue.length;
  leads.innerHTML = queue.length
    ? queue.map((lead) => `<article class="lead"><i class="lead-status"></i><div><a href="${escape(lead.finalUrl)}" target="_blank" rel="noreferrer">${escape(lead.title || lead.finalUrl)}</a><p class="why">${lead.company ? `${escape(lead.company)} · ` : ''}${escape(lead.reason)}</p></div><time>${relativeTime(lead.savedAt)}</time></article>`).join('')
    : '<div class="empty-state"><strong>Your queue is clear.</strong><p>Search a role, verify it live, then add it here for review.</p></div>';
}

async function loadState({ autoSearch = true } = {}) {
  try {
    const data = await requestJson('/api/leads');
    appState = data;
    showProfile(data.profile, data.readiness);
    showSearchConfig(data.searchConfig);
    renderQueue(data.leads);
    if (data.searchStatus.lastRunAt) document.querySelector('#last-scan').textContent = `last scan ${relativeTime(data.searchStatus.lastRunAt)}`;
    const hasSearchIntent = data.searchConfig.query || data.profile.targetRoles.length > 0;
    if (autoSearch && data.searchConfig.autoRefresh && hasSearchIntent) searchJobs({silent: true});
    else scheduleRefresh(data.searchConfig, { startTimer: hasSearchIntent });
  } catch (error) {
    leads.innerHTML = `<div class="empty-state"><strong>${escape(error.message)}</strong><p><button class="button ghost" id="retry-queue">Retry loading ClearLead</button></p></div>`;
    document.querySelector('#retry-queue').addEventListener('click', () => loadState());
  }
}

function readSearchConfig() {
  return {
    boards: list('#source-boards'),
    query: document.querySelector('#role-query').value.trim(),
    location: document.querySelector('#search-location').value.trim(),
    autoRefresh: document.querySelector('#auto-refresh').checked,
    refreshMinutes: Number(document.querySelector('#refresh-minutes').value),
  };
}

function scheduleRefresh(config, { startTimer = true } = {}) {
  clearRefreshTimers();
  if (!config.autoRefresh || !startTimer) {
    document.querySelector('#next-refresh').textContent = config.autoRefresh ? 'run a search to start auto-refresh' : 'auto-refresh off';
    return;
  }
  const nextAt = Date.now() + config.refreshMinutes * 60_000;
  const update = () => {
    const seconds = Math.max(0, Math.ceil((nextAt - Date.now()) / 1000));
    const minutes = Math.floor(seconds / 60);
    document.querySelector('#next-refresh').textContent = `next check ${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  };
  update();
  countdownTimer = setInterval(update, 1000);
  refreshTimer = setTimeout(() => searchJobs({silent: true}), config.refreshMinutes * 60_000);
}

function clearRefreshTimers() {
  clearTimeout(refreshTimer);
  clearInterval(countdownTimer);
  refreshTimer = null;
  countdownTimer = null;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {'content-type': 'application/json', ...(options.headers || {})},
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed with HTTP ${response.status}.`);
  return data;
}

function loadingCards() {
  return '<div class="empty-state"><strong>Scanning company feeds…</strong><p>Each source has its own timeout. One broken source will not block the rest.</p></div>';
}

function relativeTime(value) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return 'unknown';
  const seconds = Math.round((time - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  if (absolute < 60) return 'just now';
  const formatter = new Intl.RelativeTimeFormat('en', {numeric: 'auto'});
  if (absolute < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
  if (absolute < 86400) return formatter.format(Math.round(seconds / 3600), 'hour');
  return formatter.format(Math.round(seconds / 86400), 'day');
}

function safeHttpUrl(value) {
  try { return /^https?:$/.test(new URL(value).protocol); } catch { return false; }
}

function list(selector) {
  return document.querySelector(selector).value.split(/[,\n]/).map((value) => value.trim()).filter(Boolean);
}

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}

loadState();
