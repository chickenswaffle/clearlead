const result = document.querySelector('#result');
const leads = document.querySelector('#leads');
const readiness = document.querySelector('#readiness');
const resumeStatus = document.querySelector('#resume-status');
const resumeInsights = document.querySelector('#resume-insights');
const searchResults = document.querySelector('#search-results');
const searchSummary = document.querySelector('#search-summary');
const sourceHealth = document.querySelector('#source-health');
const tailorOutput = document.querySelector('#tailor-output');
let current = null;
let appState = null;
let resumeReady = false;
let refreshTimer = null;
let countdownTimer = null;
let searching = false;

document.querySelector('#verify').addEventListener('click', () => runVerification());
document.querySelector('#save-profile').addEventListener('click', saveProfile);
document.querySelector('#save-resume').addEventListener('click', saveResume);
document.querySelector('#resume-file').addEventListener('change', loadResumeFile);
document.querySelector('#search-jobs').addEventListener('click', () => searchJobs());
document.querySelector('#search-top').addEventListener('click', () => {
  document.querySelector(resumeReady ? '#search' : '#resume').scrollIntoView({behavior: 'smooth'});
  if (resumeReady) searchJobs();
});
document.querySelector('#role-query').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') searchJobs();
});

async function loadResumeFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!/\.(txt|md|markdown)$/i.test(file.name)) {
    showResumeError('Use a .txt or .md file, or paste the resume text directly.');
    return;
  }
  document.querySelector('#resume-text').value = await file.text();
  document.querySelector('#save-resume').dataset.filename = file.name;
  resumeStatus.textContent = `${file.name} loaded — index it to continue.`;
}

async function saveResume() {
  const button = document.querySelector('#save-resume');
  button.disabled = true;
  button.textContent = 'Indexing locally…';
  resumeStatus.className = 'readiness';
  try {
    const data = await requestJson('/api/resume', {
      method: 'POST',
      body: JSON.stringify({
        text: document.querySelector('#resume-text').value,
        filename: button.dataset.filename || 'pasted-resume.md',
      }),
    });
    showResume(data.resume);
    showProfile(appState?.profile || {targetRoles: [], locations: [], mustHaves: []}, data.readiness);
    resumeStatus.textContent = `${data.resume.message} Saved locally.`;
    document.querySelector('#search').scrollIntoView({behavior: 'smooth'});
  } catch (error) {
    showResumeError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = resumeReady ? 'Re-index resume' : 'Index resume locally';
  }
}

function showResume(summary = {}) {
  resumeReady = Boolean(summary.ready);
  resumeStatus.className = `readiness ${resumeReady ? 'ready' : 'not-ready'}`;
  resumeStatus.textContent = summary.message || 'Resume required before search.';
  const searchButton = document.querySelector('#search-jobs');
  searchButton.disabled = !resumeReady;
  searchButton.title = resumeReady ? '' : 'Add your resume first';
  if (!resumeReady) {
    resumeInsights.innerHTML = '<p class="quiet">Skills, keywords, and likely role titles will appear here after indexing.</p>';
    return;
  }
  resumeInsights.innerHTML = `<div class="resume-fact"><strong>${summary.wordCount}</strong><span>words indexed</span></div>
    <div class="insight-group"><span>explicit skills</span><div class="term-list">${(summary.skills || []).length ? summary.skills.map(termChip).join('') : '<i>none recognized yet</i>'}</div></div>
    <div class="insight-group"><span>role evidence</span><div class="term-list">${(summary.roleHints || []).length ? summary.roleHints.map(termChip).join('') : '<i>ranked from resume language</i>'}</div></div>
    <p class="quiet">${escape(summary.filename)} · saved ${relativeTime(summary.savedAt)}</p>`;
}

function showResumeError(message) {
  resumeStatus.className = 'readiness not-ready';
  resumeStatus.textContent = message;
}

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
    appState = {...appState, profile: data.profile};
    showProfile(data.profile, data.readiness);
    readiness.textContent = `${data.readiness.message} Saved locally.`;
  } catch (error) {
    readiness.className = 'readiness not-ready';
    readiness.innerHTML = `${escape(error.message)} <button class="button ghost" id="retry-profile">Retry</button>`;
    document.querySelector('#retry-profile').addEventListener('click', saveProfile);
  }
}

async function searchJobs({silent = false} = {}) {
  if (searching) return;
  if (!resumeReady) {
    document.querySelector('#resume').scrollIntoView({behavior: 'smooth'});
    showResumeError('Add and index your resume before searching.');
    return;
  }
  searching = true;
  clearRefreshTimers();
  const button = document.querySelector('#search-jobs');
  button.disabled = true;
  button.textContent = 'Building ranked pool…';
  if (!silent) {
    searchSummary.textContent = 'Reading ATS and broad feeds, deduplicating, ranking, then verifying the top matches…';
    searchResults.innerHTML = loadingCards();
  }
  try {
    const data = await requestJson('/api/search', {method: 'POST', body: JSON.stringify(readSearchConfig())});
    renderSearch(data);
    appState = {...appState, searchConfig: data.config, searchStatus: {lastRunAt: data.searchedAt}};
    scheduleRefresh(data.config);
  } catch (error) {
    searchSummary.textContent = 'Search failed. Nothing was added or marked live.';
    searchResults.innerHTML = `<div class="empty-state"><strong>${escape(error.message)}</strong><p>Retry the sources or adjust the board list.</p><button class="button ghost" id="retry-search">Retry search</button></div>`;
    document.querySelector('#retry-search').addEventListener('click', () => searchJobs());
    document.querySelector('#next-refresh').textContent = 'auto-refresh paused after error';
  } finally {
    searching = false;
    button.disabled = !resumeReady;
    button.textContent = 'Search, rank & verify';
  }
}

function renderSearch(data) {
  const healthy = data.sources.filter((source) => source.ok).length;
  document.querySelector('#stat-open').textContent = data.total;
  document.querySelector('#stat-new').textContent = data.newCount;
  document.querySelector('#stat-verified').textContent = data.verifiedCount || 0;
  document.querySelector('#last-scan').textContent = `last scan ${relativeTime(data.searchedAt)} · ${healthy}/${data.sources.length} sources`;
  searchSummary.textContent = data.outage
    ? 'Every configured source failed. No posting status was inferred.'
    : `${data.total} ranked roles · ${data.matchedCount || data.total} in the deduplicated pool · ${data.checkedCount || 0} checked · ${data.verifiedCount || 0} verified live`;
  sourceHealth.innerHTML = data.sources.map((source) => `<span class="source-chip ${source.ok ? 'ok' : 'fail'}">${escape(source.name)} · ${source.ok ? `${source.count} published${source.cached ? ' · cached' : ''}` : escape(source.error)}</span>`).join('');
  searchResults.innerHTML = data.outage
    ? '<div class="empty-state"><strong>All job sources are unavailable.</strong><p>Nothing was called published or live. Retry later or inspect source errors above.</p><button class="button ghost" id="retry-outage">Retry sources</button></div>'
    : data.jobs.length
      ? data.jobs.map(jobCard).join('')
      : '<div class="empty-state"><strong>No matching postings in the current pool.</strong><p>Try fewer title words, remove the location filter, or restore more source boards.</p></div>';
  document.querySelector('#retry-outage')?.addEventListener('click', () => searchJobs());
  wireJobActions(searchResults);
}

function jobCard(job) {
  const score = job.match?.score ?? job.relevance?.score ?? 0;
  const check = job.verification;
  const status = check?.status || 'unverified';
  const age = job.postedAt ? relativeTime(job.postedAt) : 'date unavailable';
  const badge = status === 'live' ? 'verified live' : status === 'closed' ? 'verified closed' : status === 'blocked' ? 'verification blocked' : status === 'inconclusive' ? 'not confirmed' : 'published · unverified';
  const actions = status === 'live'
    ? `<button class="button primary" data-save="${escape(check.verificationId)}">Add to queue</button><button class="button ghost" data-tailor="${escape(check.verificationId)}">Tailor resume</button>`
    : status === 'closed'
      ? '<button class="button ghost" disabled>Closed</button>'
      : `<button class="button primary" data-verify-url="${escape(job.url)}" ${metadata(job)}>Verify ${status === 'unverified' ? 'live' : 'again'}</button>`;
  const skills = job.match?.matchedSkills?.length ? job.match.matchedSkills.join(', ') : job.match?.matchedKeywords?.slice(0, 5).join(', ');
  const breakdown = job.match?.breakdown;
  return `<article class="job-card ${job.isNew ? 'new' : ''} ${status === 'live' ? 'verified' : ''} ${status === 'closed' ? 'closed' : ''}" data-job-url="${escape(job.url)}">
    <div class="job-top"><span class="company">${escape(job.company)} · ${escape(job.source)}</span><div class="badges">${job.isNew ? '<span class="badge new">new</span>' : ''}<span class="badge verification-badge ${escape(status)}">${escape(badge)}</span></div></div>
    <h3>${escape(job.title)}</h3>
    <div class="job-meta">${escape(job.location)}<br>published ${escape(age)}</div>
    <div class="score-row"><strong>${score}</strong><span>resume match</span>${breakdown ? `<i>title ${breakdown.title} · evidence ${breakdown.resume} · location ${breakdown.location} · fresh ${breakdown.freshness}</i>` : ''}</div>
    <div class="matchbar" aria-label="${score}% resume match"><i style="width:${Math.max(3, Math.min(score, 100))}%"></i></div>
    <div class="match-copy">${skills ? `matched: ${escape(skills)}` : 'No explicit skill overlap found'}${check?.reason ? `<br>${escape(check.reason)}` : ''}</div>
    <div class="job-actions">${actions}<a class="text-link" href="${escape(job.url)}" target="_blank" rel="noreferrer">open source ↗</a></div>
  </article>`;
}

function metadata(job) {
  return `data-title="${escape(job.title)}" data-company="${escape(job.company)}" data-location="${escape(job.location)}" data-source="${escape(job.source)}" data-board="${escape(job.board)}" data-posted-at="${escape(job.postedAt)}" data-first-seen-at="${escape(job.firstSeenAt)}"`;
}

function wireJobActions(container) {
  container.querySelectorAll('[data-verify-url]').forEach((button) => button.addEventListener('click', () => runVerification(button.dataset.verifyUrl, {
    title: button.dataset.title, company: button.dataset.company, location: button.dataset.location,
    source: button.dataset.source, board: button.dataset.board, postedAt: button.dataset.postedAt, firstSeenAt: button.dataset.firstSeenAt,
  })));
  container.querySelectorAll('[data-save]').forEach((button) => button.addEventListener('click', () => queueLead(button.dataset.save, button)));
  container.querySelectorAll('[data-tailor]').forEach((button) => button.addEventListener('click', () => createTailoredDraft(button.dataset.tailor, button)));
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
    current = await requestJson('/api/verify', {method: 'POST', body: JSON.stringify({url, ...metadata})});
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
    const tailorAction = check.title
      ? `<button class="button ghost" data-tailor="${escape(check.verificationId)}">Create tailored resume</button>`
      : '<span class="quiet">Tailoring is available for roles found through ranked search.</span>';
    result.insertAdjacentHTML('beforeend', `<div class="result-actions"><button class="button primary" data-save="${escape(check.verificationId)}">Add to review queue</button>${tailorAction}</div>`);
    wireJobActions(result);
  } else if (check.status === 'blocked' || check.status === 'inconclusive') {
    result.insertAdjacentHTML('beforeend', `<p class="quiet">Nothing was saved. Choose what happens next.</p>${actionMarkup(check.finalUrl || check.url)}`);
    wireOutcomeActions(check.finalUrl || check.url);
  }
}

async function queueLead(verificationId, button) {
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const saved = await requestJson('/api/leads', {method: 'POST', body: JSON.stringify({verificationId})});
    button.textContent = saved.saved ? 'Queued' : 'Already queued';
    await loadState({autoSearch: false});
  } catch (error) {
    button.disabled = false;
    button.textContent = /verifier again/i.test(error.message) ? 'Verify again' : 'Retry save';
    result.insertAdjacentHTML('beforeend', `<p class="quiet">${escape(error.message)}</p>`);
  }
}

async function createTailoredDraft(verificationId, button) {
  button.disabled = true;
  button.textContent = 'Grounding draft…';
  tailorOutput.className = 'tailor-output active';
  tailorOutput.innerHTML = '<p class="quiet">Reordering only resume evidence already present. No new claims are being written.</p>';
  try {
    const draft = await requestJson('/api/tailor', {method: 'POST', body: JSON.stringify({verificationId})});
    tailorOutput.innerHTML = `<div class="tailor-head"><div><p class="eyebrow">grounded draft ready</p><h3>${escape(draft.filename)}</h3></div><a class="button primary" href="${escape(draft.downloadUrl)}">Download markdown</a></div>
      <p class="quiet">Matched evidence: ${escape(draft.matchedTerms.join(', ') || 'none')}<br>Not added from the job description: ${escape(draft.absentTerms.join(', ') || 'none')}</p>
      <details><summary>Preview draft</summary><pre>${escape(draft.preview)}</pre></details>`;
    tailorOutput.scrollIntoView({behavior: 'smooth', block: 'center'});
    button.textContent = 'Draft ready';
  } catch (error) {
    tailorOutput.innerHTML = `<strong>${escape(error.message)}</strong><p class="quiet">Verify the role again, then retry. Nothing was submitted.</p>`;
    button.disabled = false;
    button.textContent = 'Retry tailoring';
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
    const actions = card.querySelector('.job-actions');
    if (actions && check.verificationId) {
      actions.innerHTML = `<button class="button primary" data-save="${escape(check.verificationId)}">Add to queue</button><button class="button ghost" data-tailor="${escape(check.verificationId)}">Tailor resume</button><a class="text-link" href="${escape(check.finalUrl || check.url)}" target="_blank" rel="noreferrer">open source ↗</a>`;
      wireJobActions(actions);
    }
  } else if (check.status === 'closed') {
    badge.textContent = 'verified closed';
    card.classList.add('closed');
    if (verifyButton) { verifyButton.disabled = true; verifyButton.textContent = 'Closed'; }
  } else badge.textContent = check.status === 'blocked' ? 'verification blocked' : 'not confirmed';
}

function renderRequestFailure(message, url) {
  result.className = 'result inconclusive';
  result.innerHTML = `<div class="status">check failed</div><strong>${escape(message)}</strong><p class="quiet">Nothing was saved.</p>${actionMarkup(url)}`;
  wireOutcomeActions(url);
}
function actionMarkup(url) { const open = safeHttpUrl(url) ? `<a href="${escape(url)}" target="_blank" rel="noreferrer">open source ↗</a>` : ''; return `<p><button class="button ghost" id="retry-check">Retry</button> ${open} <button class="button ghost" id="discard-check">Discard</button></p>`; }
function wireOutcomeActions(url) {
  document.querySelector('#retry-check').addEventListener('click', () => runVerification(url));
  document.querySelector('#discard-check').addEventListener('click', () => { current = null; result.className = ''; result.innerHTML = '<p class="quiet">Discarded. Nothing was saved.</p>'; });
}

function showProfile(profile, state) {
  document.querySelector('#target-roles').value = (profile.targetRoles || []).join(', ');
  document.querySelector('#locations').value = (profile.locations || []).join(', ');
  document.querySelector('#must-haves').value = (profile.mustHaves || []).join(', ');
  readiness.className = state.ready ? 'readiness ready' : 'readiness not-ready';
  readiness.textContent = state.message;
}

function showSearchConfig(config) {
  document.querySelector('#role-query').value = config.query;
  document.querySelector('#search-location').value = config.location;
  document.querySelector('#greenhouse-boards').value = (config.greenhouseBoards || config.boards || []).join(', ');
  document.querySelector('#lever-sites').value = (config.leverSites || []).join(', ');
  document.querySelector('#ashby-boards').value = (config.ashbyBoards || []).join(', ');
  document.querySelector('#broad-feeds').value = (config.broadFeeds || []).join(', ');
  document.querySelector('#auto-refresh').checked = config.autoRefresh;
  document.querySelector('#refresh-minutes').value = String(config.refreshMinutes);
  document.querySelector('#auto-verify').checked = config.autoVerify !== false;
  document.querySelector('#verify-limit').value = String(config.verifyLimit || 8);
}

function renderQueue(queue) {
  document.querySelector('#stat-queue').textContent = queue.length;
  leads.innerHTML = queue.length
    ? queue.map((lead) => `<article class="lead"><i class="lead-status"></i><div><a href="${escape(lead.finalUrl)}" target="_blank" rel="noreferrer">${escape(lead.title || lead.finalUrl)}</a><p class="why">${lead.company ? `${escape(lead.company)} · ` : ''}${escape(lead.reason)}</p></div><time>${relativeTime(lead.savedAt)}</time></article>`).join('')
    : '<div class="empty-state"><strong>Your queue is clear.</strong><p>Search a role, verify it live, then add it here for review.</p></div>';
}

async function loadState({autoSearch = true} = {}) {
  try {
    const data = await requestJson('/api/leads');
    appState = data;
    showResume(data.resume);
    showProfile(data.profile, data.readiness);
    showSearchConfig(data.searchConfig);
    renderQueue(data.leads);
    if (data.searchStatus.lastRunAt) document.querySelector('#last-scan').textContent = `last scan ${relativeTime(data.searchStatus.lastRunAt)}`;
    const hasPreviousSearch = Boolean(data.searchStatus.lastRunAt);
    if (autoSearch && resumeReady && data.searchConfig.autoRefresh && hasPreviousSearch) searchJobs({silent: true});
    else scheduleRefresh(data.searchConfig, {startTimer: resumeReady && hasPreviousSearch});
  } catch (error) {
    leads.innerHTML = `<div class="empty-state"><strong>${escape(error.message)}</strong><p><button class="button ghost" id="retry-queue">Retry loading ClearLead</button></p></div>`;
    document.querySelector('#retry-queue').addEventListener('click', () => loadState());
  }
}

function readSearchConfig() {
  return {
    greenhouseBoards: list('#greenhouse-boards'), leverSites: list('#lever-sites'), ashbyBoards: list('#ashby-boards'), broadFeeds: list('#broad-feeds'),
    query: document.querySelector('#role-query').value.trim(), location: document.querySelector('#search-location').value.trim(),
    autoRefresh: document.querySelector('#auto-refresh').checked, refreshMinutes: Number(document.querySelector('#refresh-minutes').value),
    autoVerify: document.querySelector('#auto-verify').checked, verifyLimit: Number(document.querySelector('#verify-limit').value),
  };
}

function scheduleRefresh(config, {startTimer = true} = {}) {
  clearRefreshTimers();
  if (!config.autoRefresh || !startTimer) {
    document.querySelector('#next-refresh').textContent = config.autoRefresh ? 'run a search to start auto-refresh' : 'auto-refresh off';
    return;
  }
  const nextAt = Date.now() + config.refreshMinutes * 60_000;
  const update = () => { const seconds = Math.max(0, Math.ceil((nextAt - Date.now()) / 1000)); document.querySelector('#next-refresh').textContent = `next check ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
  update();
  countdownTimer = setInterval(update, 1000);
  refreshTimer = setTimeout(() => searchJobs({silent: true}), config.refreshMinutes * 60_000);
}
function clearRefreshTimers() { clearTimeout(refreshTimer); clearInterval(countdownTimer); refreshTimer = null; countdownTimer = null; }
async function requestJson(url, options = {}) { const response = await fetch(url, {...options, headers: {'content-type': 'application/json', ...(options.headers || {})}}); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || `Request failed with HTTP ${response.status}.`); return data; }
function loadingCards() { return '<div class="empty-state"><strong>Building the ranked pool…</strong><p>Sources fail independently. The highest matches are verified with capped concurrency.</p></div>'; }
function relativeTime(value) { const time = Date.parse(value || ''); if (!Number.isFinite(time)) return 'unknown'; const seconds = Math.round((time - Date.now()) / 1000); const absolute = Math.abs(seconds); if (absolute < 60) return 'just now'; const formatter = new Intl.RelativeTimeFormat('en', {numeric: 'auto'}); if (absolute < 3600) return formatter.format(Math.round(seconds / 60), 'minute'); if (absolute < 86400) return formatter.format(Math.round(seconds / 3600), 'hour'); return formatter.format(Math.round(seconds / 86400), 'day'); }
function safeHttpUrl(value) { try { return /^https?:$/.test(new URL(value).protocol); } catch { return false; } }
function list(selector) { return document.querySelector(selector).value.split(/[,\n]/).map((value) => value.trim()).filter(Boolean); }
function termChip(value) { return `<span>${escape(value)}</span>`; }
function escape(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }

loadState();
