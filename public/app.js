const result = document.querySelector('#result');
const leads = document.querySelector('#leads');
const readiness = document.querySelector('#readiness');
const discovery = document.querySelector('#discovery');
let current = null;

document.querySelector('#verify').addEventListener('click', () => runVerification());
document.querySelector('#save-profile').addEventListener('click', saveProfile);
document.querySelector('#discover').addEventListener('click', discoverGreenhouse);

async function saveProfile() {
  readiness.className = 'quiet';
  readiness.textContent = 'Saving locally…';
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
  } catch (error) {
    readiness.className = 'quiet not-ready';
    readiness.innerHTML = `${escape(error.message)} <button class="secondary" id="retry-profile">Retry</button>`;
    document.querySelector('#retry-profile').addEventListener('click', saveProfile);
  }
}

async function discoverGreenhouse() {
  const board = document.querySelector('#greenhouse-board').value.trim();
  discovery.innerHTML = '<p class="quiet">Reading the published Greenhouse feed…</p>';
  try {
    const data = await requestJson('/api/discover/greenhouse', {
      method: 'POST',
      body: JSON.stringify({board}),
    });
    if (data.error) {
      renderDiscoveryFailure(data.error);
      return;
    }
    discovery.innerHTML = data.jobs.length
      ? data.jobs.map(foundCard).join('')
      : '<p class="quiet">No published roles were returned for that board.</p>';
    discovery.querySelectorAll('[data-verify-url]').forEach((button) => {
      button.addEventListener('click', () => runVerification(button.dataset.verifyUrl));
    });
  } catch (error) {
    renderDiscoveryFailure(error.message);
  }
}

function renderDiscoveryFailure(message) {
  discovery.innerHTML = `<div class="result inconclusive"><div class="status">Discovery failed</div><strong>${escape(message)}</strong><p><button id="retry-discovery">Retry</button> <button class="secondary" id="discard-discovery">Discard</button></p></div>`;
  document.querySelector('#retry-discovery').addEventListener('click', discoverGreenhouse);
  document.querySelector('#discard-discovery').addEventListener('click', () => { discovery.innerHTML = '<p class="quiet">Discovery discarded.</p>'; });
}

async function runVerification(discoveredUrl) {
  const urlInput = document.querySelector('#job-url');
  if (discoveredUrl) urlInput.value = discoveredUrl;
  const url = urlInput.value.trim();
  current = null;
  result.className = 'result inconclusive';
  result.innerHTML = '<p class="quiet">Checking the source…</p>';
  result.scrollIntoView({behavior: 'smooth', block: 'center'});
  try {
    current = await requestJson('/api/verify', {
      method: 'POST',
      body: JSON.stringify({url}),
    });
    renderResult(current);
  } catch (error) {
    renderRequestFailure(error.message, url);
  }
}

function renderResult(check) {
  result.className = `result ${check.status || 'inconclusive'}`;
  result.innerHTML = `<div class="status">${escape(check.status || 'invalid request')}</div><strong>${escape(check.reason || check.error)}</strong><p class="why">${check.checkedAt ? `Checked ${new Date(check.checkedAt).toLocaleString()}` : ''}${check.httpStatus ? ` · HTTP ${check.httpStatus}` : ''}${check.finalUrl || check.url ? `<br>${escape(check.finalUrl || check.url)}` : ''}</p>`;
  if (check.status === 'live') {
    const save = document.createElement('button');
    save.textContent = 'Save this live lead';
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
        if (needsVerification) save.onclick = () => runVerification(current.finalUrl || current.url);
        result.insertAdjacentHTML('beforeend', `<p class="quiet">${escape(error.message)}</p>`);
        return;
      }
      save.textContent = saved.saved ? 'Saved' : 'Already saved';
      result.insertAdjacentHTML('beforeend', `<p class="quiet">${escape(saved.saved ? 'Saved.' : saved.reason)}</p>`);
      await load();
    };
    result.append(save);
  } else if (check.status === 'blocked' || check.status === 'inconclusive') {
    result.insertAdjacentHTML('beforeend', `<p class="quiet">Nothing was saved. Choose what happens next.</p>${actionMarkup(check.finalUrl || check.url)}`);
    wireOutcomeActions(check.finalUrl || check.url);
  }
}

function renderRequestFailure(message, url) {
  result.className = 'result inconclusive';
  result.innerHTML = `<div class="status">Check failed</div><strong>${escape(message)}</strong><p class="quiet">Nothing was saved. Choose what happens next.</p>${actionMarkup(url)}`;
  wireOutcomeActions(url);
}

function actionMarkup(url) {
  const open = safeHttpUrl(url)
    ? `<a href="${escape(url)}" target="_blank" rel="noreferrer">Open source</a>`
    : '';
  return `<p><button id="retry-check">Retry</button> ${open} <button class="secondary" id="discard-check">Discard</button></p>`;
}

function wireOutcomeActions(url) {
  document.querySelector('#retry-check').addEventListener('click', () => runVerification(url));
  document.querySelector('#discard-check').addEventListener('click', () => {
    current = null;
    result.className = '';
    result.innerHTML = '<p class="quiet">Discarded. Nothing was saved.</p>';
  });
}

function foundCard(job) {
  const relevance = job.relevance
    ? `${job.relevance.score}% title match · ${job.relevance.matched.length ? `matched ${job.relevance.matched.join(', ')}` : 'no target terms matched'}`
    : 'Add a target role to calculate relevance';
  return `<article class="found"><div class="status">Published · not yet verified</div><h3>${escape(job.title)}</h3><p class="why">${escape(job.location)} · ${escape(relevance)}</p><button data-verify-url="${escape(job.url)}">Verify now</button><a href="${escape(job.url)}" target="_blank" rel="noreferrer">Open source</a></article>`;
}

function showProfile(profile, state) {
  document.querySelector('#target-roles').value = profile.targetRoles.join(', ');
  document.querySelector('#locations').value = profile.locations.join(', ');
  document.querySelector('#must-haves').value = profile.mustHaves.join(', ');
  readiness.className = state.ready ? 'quiet ready' : 'quiet not-ready';
  readiness.textContent = state.message;
}

async function load() {
  try {
    const data = await requestJson('/api/leads');
    showProfile(data.profile, data.readiness);
    leads.innerHTML = data.leads.length
      ? data.leads.map((lead) => `<article class="lead live"><div class="status">Review · live</div><a href="${escape(lead.finalUrl)}" target="_blank" rel="noreferrer">${escape(lead.finalUrl)}</a><p class="why">${escape(lead.reason)} · ${new Date(lead.checkedAt).toLocaleString()}</p></article>`).join('')
      : '<p class="quiet">No verified leads in your queue yet.</p>';
  } catch (error) {
    leads.innerHTML = `<div class="result inconclusive"><strong>${escape(error.message)}</strong><p><button id="retry-queue">Retry queue</button></p></div>`;
    document.querySelector('#retry-queue').addEventListener('click', load);
  }
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

function safeHttpUrl(value) {
  try { return /^https?:$/.test(new URL(value).protocol); } catch { return false; }
}

function list(selector) {
  return document.querySelector(selector).value.split(/[,\n]/).map((value) => value.trim()).filter(Boolean);
}

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}

load();
