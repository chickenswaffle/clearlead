const result = document.querySelector('#result');
const leads = document.querySelector('#leads');
const readiness = document.querySelector('#readiness');
const resumeStatus = document.querySelector('#resume-status');
const resumeInsights = document.querySelector('#resume-insights');
const searchResults = document.querySelector('#search-results');
const searchSummary = document.querySelector('#search-summary');
const sourceHealth = document.querySelector('#source-health');
const tailorOutput = document.querySelector('#tailor-output');
const autofillOutput = document.querySelector('#autofill-output');
const applications = document.querySelector('#applications');
let current = null;
let appState = null;
let resumeReady = false;
let refreshTimer = null;
let countdownTimer = null;
let searching = false;
let verifying = false;
let lastBrowserCaptureId = '';
let pairingPollTimer = null;
let aiState = {configured: false, provider: '', model: ''};

document.querySelector('#verify').addEventListener('click', () => runVerification());
document.querySelector('#job-url').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') runVerification();
});
document.querySelector('#save-profile').addEventListener('click', saveProfile);
document.querySelector('#save-resume').addEventListener('click', saveResume);
document.querySelector('#resume-file').addEventListener('change', loadResumeFile);
document.querySelector('#search-jobs').addEventListener('click', () => searchJobs());
document.querySelector('#search-top').addEventListener('click', () => {
  const target = resumeReady ? document.querySelector('#search') : document.querySelector('#resume');
  target.scrollIntoView({behavior: 'smooth'});
  (resumeReady ? document.querySelector('#smart-search') : document.querySelector('#resume-text')).focus();
});
document.querySelector('#smart-search').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') searchJobs();
});
document.querySelector('#save-provider').addEventListener('click', saveProvider);
document.querySelector('#test-provider').addEventListener('click', testProvider);
document.querySelector('#remove-provider').addEventListener('click', removeProvider);
document.querySelector('#ai-provider').addEventListener('change', updateModelPlaceholder);
document.querySelector('#pair-extension').addEventListener('click', pairExtension);
document.querySelector('#test-extension').addEventListener('click', testExtensionConnection);
document.querySelector('#unpair-extension').addEventListener('click', unpairExtension);
document.querySelector('#add-past-application').addEventListener('click', addPastApplication);
document.querySelector('#outcome-learning-toggle').addEventListener('change', saveOutcomeLearningSetting);
applications.addEventListener('click', (event) => {
  const button = event.target.closest('[data-save-outcome]');
  if (button) saveApplicationOutcome(button.dataset.saveOutcome, button);
});
document.querySelector('#resume-toggle').addEventListener('click', () => {
  const section = document.querySelector('#resume');
  const collapsed = section.classList.toggle('is-complete');
  document.querySelector('#resume-toggle').textContent = collapsed ? 'Edit resume' : 'Hide resume';
});
document.querySelectorAll('a[href="#resume"]').forEach((link) => link.addEventListener('click', () => {
  document.querySelector('#resume').classList.remove('is-complete');
  document.querySelector('#resume-toggle').textContent = 'Hide resume';
}));

function updateModelPlaceholder() {
  const provider = document.querySelector('#ai-provider').value;
  document.querySelector('#ai-model').placeholder = provider === 'openrouter' ? 'e.g. openai/gpt-5.4 or your preferred model' : provider === 'openai' ? 'A model enabled for your OpenAI API account' : 'A Claude model enabled for your API account';
}

async function saveProvider() {
  const button = document.querySelector('#save-provider');
  button.disabled = true;
  showAIMessage('Encrypting provider settings locally…');
  try {
    aiState = await requestJson('/api/ai/provider', {method: 'POST', body: JSON.stringify({provider: document.querySelector('#ai-provider').value, model: document.querySelector('#ai-model').value.trim(), apiKey: document.querySelector('#ai-key').value.trim()})});
    document.querySelector('#ai-key').value = '';
    showAI(aiState);
    showAIMessage(aiState.message, 'ok');
  } catch (error) { showAIMessage(error.message, 'error'); }
  finally { button.disabled = false; }
}

async function testProvider() {
  const button = document.querySelector('#test-provider');
  button.disabled = true;
  showAIMessage('Testing the saved key without sending resume data…');
  try {
    const outcome = await requestJson('/api/ai/test', {method: 'POST', body: '{}'});
    showAIMessage(outcome.message, 'ok');
  } catch (error) { showAIMessage(error.message, 'error'); }
  finally { button.disabled = false; }
}

async function removeProvider() {
  const button = document.querySelector('#remove-provider');
  button.disabled = true;
  try {
    aiState = await requestJson('/api/ai/provider/remove', {method: 'POST', body: '{}'});
    showAI(aiState);
    showAIMessage(aiState.message, 'ok');
  } catch (error) { showAIMessage(error.message, 'error'); }
  finally { button.disabled = false; }
}

function showAI(state = {}) {
  aiState = state;
  const status = document.querySelector('#ai-status');
  status.className = `readiness ${state.configured ? 'ready' : 'not-ready'}`;
  status.textContent = state.configured ? `${providerName(state.provider)} · ${state.model} · ${state.keyHint}` : 'Optional — local tailoring works without a key.';
  if (state.configured) {
    document.querySelector('#ai-provider').value = state.provider;
    document.querySelector('#ai-model').value = state.model;
    document.querySelector('#ai-key-hint').textContent = `${state.keyHint} saved. Leave the key blank to keep it while changing the model.`;
  } else document.querySelector('#ai-key-hint').textContent = 'The browser never receives a saved key.';
  updateModelPlaceholder();
}

function showAIMessage(message, type = '') {
  const output = document.querySelector('#ai-result');
  output.className = `provider-result span-2 ${type}`;
  output.textContent = message || '';
}

async function loadResumeFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!/\.(pdf|txt|md|markdown)$/i.test(file.name)) {
    showResumeError('Use a PDF, .txt, or .md file, or paste the resume text directly.');
    return;
  }
  const button = document.querySelector('#save-resume');
  try {
    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
      if (file.size > 10 * 1024 * 1024) throw new Error('Resume PDF is too large. Use a file under 10 MB.');
      resumeStatus.className = 'readiness';
      resumeStatus.textContent = `Extracting ${file.name} locally…`;
      const response = await fetch('/api/resume/pdf', {method: 'POST', headers: {'content-type': 'application/pdf'}, body: file});
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `PDF extraction failed with HTTP ${response.status}.`);
      document.querySelector('#resume-text').value = data.text;
      resumeStatus.textContent = `${data.message} ${data.wordCount} words found.${data.warnings?.length ? ` ${data.warnings.join(' ')}` : ''}`;
    } else {
      document.querySelector('#resume-text').value = await file.text();
      resumeStatus.textContent = `${file.name} loaded — review and index it to continue.`;
    }
    button.dataset.filename = file.name;
  } catch (error) { showResumeError(error.message); }
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
    showProfile(appState?.profile || {targetRoles: [], locations: [], preferences: [], mustHaves: []}, data.readiness);
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
  const resumeSection = document.querySelector('#resume');
  const resumeToggle = document.querySelector('#resume-toggle');
  resumeToggle.hidden = !resumeReady;
  resumeSection.classList.toggle('is-complete', resumeReady);
  resumeToggle.textContent = resumeReady ? 'Edit resume' : 'Hide resume';
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
  updateJourney(appState || {});
}

function showResumeError(message) {
  resumeStatus.className = 'readiness not-ready';
  resumeStatus.textContent = message;
}

async function saveProfile() {
  readiness.className = 'readiness';
  readiness.textContent = 'saving locally…';
  try {
    const [data, application] = await Promise.all([
      requestJson('/api/profile', {method: 'POST', body: JSON.stringify({
        targetRoles: list('#target-roles'),
        locations: list('#locations'),
        preferences: list('#preferences'),
        mustHaves: list('#must-haves'),
      })}),
      requestJson('/api/application-profile', {method: 'POST', body: JSON.stringify(readApplicationProfile())}),
    ]);
    appState = {...appState, profile: data.profile, applicationProfile: application.applicationProfile, applicationReadiness: application.readiness};
    showProfile(data.profile, data.readiness);
    showApplicationProfile(application.applicationProfile, application.readiness);
    readiness.textContent = `${data.readiness.message} ${application.readiness.message} Saved locally.`;
  } catch (error) {
    readiness.className = 'readiness not-ready';
    readiness.innerHTML = `${escape(error.message)} <button class="button ghost" id="retry-profile">Retry</button>`;
    document.querySelector('#retry-profile').addEventListener('click', saveProfile);
  }
}

function readApplicationProfile() {
  return {
    fullName: value('#full-name'), email: value('#application-email'), phone: value('#application-phone'), location: value('#application-location'),
    city: value('#application-city'), state: value('#application-state'), postalCode: value('#application-postal'), country: value('#application-country'),
    linkedinUrl: value('#linkedin-url'), githubUrl: value('#github-url'), portfolioUrl: value('#portfolio-url'), desiredSalary: value('#desired-salary'),
    workAuthorization: value('#work-authorization'), needsSponsorship: value('#needs-sponsorship'),
    age18OrOlder: value('#age-18'), backgroundCheckConsent: value('#background-consent'), restrictiveAgreement: value('#restrictive-agreement'),
    otherLanguageFluency: value('#other-language'), priorSrsEmployment: value('#prior-srs'), currentSrsAssociate: value('#current-srs'),
    currentHomeDepotAssociate: value('#current-home-depot'), relatedIndustryExperience: value('#related-industry'), relocation: value('#relocation'),
    workArrangement: value('#work-arrangement'), startAvailability: value('#start-availability'),
  };
}

function showApplicationProfile(profile = {}, state = {}) {
  const fields = {'#full-name':'fullName','#application-email':'email','#application-phone':'phone','#application-location':'location','#application-city':'city','#application-state':'state','#application-postal':'postalCode','#application-country':'country','#linkedin-url':'linkedinUrl','#github-url':'githubUrl','#portfolio-url':'portfolioUrl','#desired-salary':'desiredSalary','#work-authorization':'workAuthorization','#needs-sponsorship':'needsSponsorship','#age-18':'age18OrOlder','#background-consent':'backgroundCheckConsent','#restrictive-agreement':'restrictiveAgreement','#other-language':'otherLanguageFluency','#prior-srs':'priorSrsEmployment','#current-srs':'currentSrsAssociate','#current-home-depot':'currentHomeDepotAssociate','#related-industry':'relatedIndustryExperience','#relocation':'relocation','#work-arrangement':'workArrangement','#start-availability':'startAvailability'};
  const choiceFields = new Set(['#work-authorization', '#needs-sponsorship', '#age-18', '#background-consent', '#restrictive-agreement', '#other-language', '#prior-srs', '#current-srs', '#current-home-depot', '#related-industry', '#relocation', '#work-arrangement', '#start-availability']);
  for (const [selector, key] of Object.entries(fields)) document.querySelector(selector).value = profile[key] || (choiceFields.has(selector) ? 'unknown' : '');
  if (state.message && !state.ready) readiness.textContent = `${readiness.textContent} ${state.message}`.trim();
}

async function pairExtension() {
  const button = document.querySelector('#pair-extension');
  button.disabled = true;
  try {
    const pairing = await requestJson('/api/extension/pair', {method: 'POST', body: '{}'});
    renderExtensionPairing({state: 'waiting', tokenActive: true, expectedVersion: pairing.expectedVersion, expiresAt: pairing.expiresAt});
    document.querySelector('#pairing-output').innerHTML = `<p>1. Open <code>chrome://extensions</code>, enable Developer mode, and load or reload this unpacked folder:</p><code>${escape(pairing.extensionPath)}</code><p>2. Confirm the extension shows version <strong>${escape(pairing.expectedVersion)}</strong>, then paste this one-time token:</p><div class="token-row"><code id="pairing-token">${escape(pairing.token)}</code><button class="button ghost" id="copy-pairing">Copy token</button></div><p class="quiet">ClearLead is waiting for the extension to prove the connection. Creating another token invalidates this one.</p>`;
    document.querySelector('#copy-pairing').addEventListener('click', async () => { await navigator.clipboard.writeText(pairing.token); document.querySelector('#copy-pairing').textContent = 'Copied'; });
    startPairingPoll();
  } catch (error) { document.querySelector('#pairing-output').textContent = error.message; }
  finally { button.disabled = false; }
}

async function testExtensionConnection({quiet = false} = {}) {
  const button = document.querySelector('#test-extension');
  button.disabled = true;
  try {
    const data = await requestJson('/api/extension/status');
    renderExtensionPairing(data.pairing);
    if (!quiet) document.querySelector('#pairing-output').innerHTML = pairingStatusMessage(data.pairing);
    return data.pairing;
  } catch (error) {
    if (!quiet) document.querySelector('#pairing-output').textContent = error.message;
    return null;
  } finally { button.disabled = false; }
}

async function unpairExtension() {
  if (!window.confirm('Revoke the current browser pairing? The extension will clear its token and must be paired again.')) return;
  const data = await requestJson('/api/extension/unpair', {method: 'POST', body: '{}'});
  clearInterval(pairingPollTimer);
  renderExtensionPairing(data.pairing);
  document.querySelector('#pairing-output').innerHTML = `<p>${escape(data.message)}</p>`;
}

function startPairingPoll() {
  clearInterval(pairingPollTimer);
  let attempts = 0;
  pairingPollTimer = setInterval(async () => {
    attempts += 1;
    const pairing = await testExtensionConnection({quiet: true});
    if (pairing?.connected || attempts >= 30) {
      clearInterval(pairingPollTimer);
      if (pairing?.connected) document.querySelector('#pairing-output').innerHTML = pairingStatusMessage(pairing);
    }
  }, 2_000);
}

function renderExtensionPairing(pairing = {}) {
  appState = {...(appState || {}), extensionPairing: pairing};
  const status = document.querySelector('#extension-status');
  const connected = pairing.state === 'connected' && !pairing.updateRequired;
  status.className = `readiness ${connected ? 'ready' : 'not-ready'}`;
  status.textContent = pairing.state === 'connected'
    ? pairing.updateRequired ? `Connected, but extension v${pairing.receivedVersion || '?'} must update to v${pairing.expectedVersion}.` : `Connected live · extension v${pairing.receivedVersion || pairing.expectedVersion} · seen ${relativeTime(pairing.lastSeenAt)}`
    : pairing.state === 'waiting' ? 'Token created — waiting for the extension to confirm it.'
      : pairing.state === 'stale' ? `Pairing stale · last seen ${relativeTime(pairing.lastSeenAt)}. Open the extension or replace the token.`
        : 'Extension not paired.';
  document.querySelector('#test-extension').disabled = !pairing.tokenActive;
  document.querySelector('#unpair-extension').disabled = !pairing.tokenActive;
  document.querySelector('#pair-extension').textContent = pairing.tokenActive ? 'Replace pairing token' : 'Create pairing token';
}

function pairingStatusMessage(pairing = {}) {
  if (pairing.connected && !pairing.updateRequired) return `<p><strong>Connection confirmed live.</strong> Extension v${escape(pairing.receivedVersion)} checked in ${escape(relativeTime(pairing.lastSeenAt))}. This pairing expires ${escape(new Date(pairing.expiresAt).toLocaleDateString())}.</p>`;
  if (pairing.updateRequired) return `<p><strong>Extension update required.</strong> ClearLead expects v${escape(pairing.expectedVersion)}, but the browser reported v${escape(pairing.receivedVersion || 'unknown')}. Reload the unpacked extension once; future updates are detected and reloaded automatically.</p>`;
  if (pairing.state === 'waiting') return '<p>The token exists, but no extension has successfully used it yet. Paste it into the extension and leave the side panel open while ClearLead confirms the connection.</p>';
  if (pairing.state === 'stale') return '<p>The saved token has not checked in recently. Open the ClearLead extension on any page, then retest. If it clears the token, create a replacement token here.</p>';
  return '<p>No active browser pairing exists. Create a token, then paste it into the extension.</p>';
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
    searchSummary.textContent = 'Expanding your request, searching employer-direct and ATS sources, ranking from your resume, then checking the best matches…';
    searchResults.innerHTML = loadingCards();
  }
  try {
    const prompt = document.querySelector('#smart-search').value.trim();
    if (!prompt) throw new Error('Type the kind of job you want first.');
    const advancedOpen = document.querySelector('.advanced-search').open;
    const data = await requestJson('/api/search/smart', {method: 'POST', body: JSON.stringify({prompt, useAI: aiState.configured && document.querySelector('#use-ai-search').checked, autoVerify: document.querySelector('#auto-verify').checked, verifyLimit: Number(document.querySelector('#verify-limit').value), advanced: advancedOpen ? readSearchConfig() : undefined})});
    renderSearch(data);
    showSearchConfig(data.config);
    appState = {...appState, searchConfig: data.config, searchStatus: {lastRunAt: data.searchedAt}};
    updateJourney(appState);
    scheduleRefresh(data.config);
  } catch (error) {
    searchSummary.textContent = 'Search failed. Nothing was added or marked live.';
    searchResults.innerHTML = `<div class="empty-state"><strong>${escape(error.message)}</strong><p>Retry, or open Fine-tune search if you want to adjust sources.</p><button class="button ghost" id="retry-search">Retry search</button></div>`;
    document.querySelector('#retry-search').addEventListener('click', () => searchJobs());
    document.querySelector('#next-refresh').textContent = 'auto-refresh paused after error';
  } finally {
    searching = false;
    button.disabled = !resumeReady;
    button.textContent = 'Find my best matches';
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
    : `${data.total} actionable roles · ${data.funnel?.discovered ?? '—'} discovered · ${data.funnel?.titleMismatch ?? 0} outside target roles · ${data.funnel?.locationMismatch ?? 0} outside target area · ${data.rejectedCount || 0} hard-rejected · ${data.funnel?.fitSkipped ?? 0} weak/unsupported fits hidden · ${data.funnel?.duplicatesRemoved ?? 0} duplicates removed · ${data.checkedCount || 0} checked · ${data.verifiedCount || 0} verified live`;
  const sourceMode = (mode) => ({'query-aligned':'query-aligned','supplemental-unfiltered':'supplemental/unfiltered','full-feed-local-filtered':'full feed/local filter','employer-board-local-filtered':'employer board/local filter','employer-site-full':'employer careers site'}[mode] || 'coverage mode unknown');
  const activeSources = data.sources.map((source) => `<span class="source-chip ${source.ok ? 'ok' : 'fail'}">${escape(source.name)} · ${source.ok ? `${source.count} published · ${escape(sourceMode(source.queryMode))}${source.cached ? ' · cached' : ''}${source.note ? ` · ${escape(source.note)}` : ''}` : escape(source.error)}</span>`).join('');
  const gatedSources = (data.providerAccess || []).filter((provider) => provider.status === 'partner-required').map((provider) => `<span class="source-chip gate">${escape(provider.name)} · partner access needed</span>`).join('');
  const manualSources = (data.manualEmployers || []).filter((item) => /^https:\/\//.test(item.url || '')).map((item) => `<a class="source-chip gate" href="${escape(item.url)}" target="_blank" rel="noopener noreferrer" title="${escape(item.reason || '')}">${escape(item.name)} · open their site ↗</a>`).join('');
  sourceHealth.innerHTML = activeSources + gatedSources + manualSources;
  searchResults.innerHTML = data.outage
    ? '<div class="empty-state"><strong>All job sources are unavailable.</strong><p>Nothing was called published or live. Retry later or inspect source errors above.</p><button class="button ghost" id="retry-outage">Retry sources</button></div>'
    : data.jobs.length
      ? `${data.jobs.slice(0, 6).map(jobCard).join('')}${data.jobs.length > 6 ? `<div class="more-results"><button class="button ghost" id="show-more-jobs">Show ${data.jobs.length - 6} more matches</button></div>` : ''}`
      : '<div class="empty-state"><strong>No matching postings in the current pool.</strong><p>Try fewer title words, remove the location filter, or restore more source boards.</p></div>';
  const plan = document.querySelector('#search-plan');
  plan.innerHTML = data.plan ? `<strong>${escape(data.plan.mode === 'ai' ? 'AI-expanded search' : 'Built-in expanded search')} · ${escape(data.plan.explanation)}</strong>${(data.plan.titles || []).slice(0, 10).map((item) => `<span>${escape(item)}</span>`).join('')}${(data.plan.locations || []).slice(0, 8).map((item) => `<span>near ${escape(item)}</span>`).join('')}${data.plan.note ? `<span>${escape(data.plan.note)}</span>` : ''}` : '';
  document.querySelector('#retry-outage')?.addEventListener('click', () => searchJobs());
  document.querySelector('#show-more-jobs')?.addEventListener('click', () => {
    searchResults.innerHTML = data.jobs.map(jobCard).join('');
    wireJobActions(searchResults);
  });
  wireJobActions(searchResults);
}

function jobCard(job) {
  const score = job.match?.score ?? job.relevance?.score ?? 0;
  const check = job.verification;
  const status = check?.status || 'unverified';
  const age = job.postedAt ? relativeTime(job.postedAt) : 'date unavailable';
  const badge = status === 'live' ? 'verified live' : status === 'closed' ? 'verified closed' : status === 'blocked' ? 'verification blocked' : status === 'inconclusive' ? 'not confirmed' : 'published · unverified';
  const jobUrl = safeHttpUrl(job.applyUrl || job.url) ? job.applyUrl || job.url : '';
  const actions = status === 'live'
    ? `<button class="button ghost" data-resume="${escape(check.verificationId)}">Make custom resume</button><button class="button ghost" data-autofill="${escape(check.verificationId)}">Prepare application</button>`
    : status === 'closed'
      ? '<button class="button ghost" disabled>Closed</button>'
      : status === 'blocked' && jobUrl
        ? `<a class="button primary" href="${escape(jobUrl)}" target="_blank" rel="noreferrer">Open for browser check</a>`
        : `<button class="button primary" data-verify-url="${escape(job.applyUrl || job.url)}" ${metadata(job)}>Verify ${status === 'unverified' ? 'role' : 'again'}</button>`;
  const skills = job.match?.matchedSkills?.length ? job.match.matchedSkills.join(', ') : job.match?.matchedKeywords?.slice(0, 5).join(', ');
  const breakdown = job.match?.breakdown;
  const application = job.match?.application;
  const confidence = job.match?.confidence;
  const reasons = job.match?.reasons || [];
  const risks = job.match?.risks || [];
  const decision = job.match?.decision;
  const outcomeLearning = job.match?.outcomeLearning;
  const qualifications = job.match?.qualifications?.items || [];
  const sourceUrl = safeHttpUrl(job.url) ? job.url : '#verify-panel';
  const verificationEvidence = check ? verificationEvidenceMarkup({...check, source: check.source || job.source}, {allowSave: status === 'live'}) : '';
  return `<article class="job-card ${job.isNew ? 'new' : ''} ${status === 'live' ? 'verified' : ''} ${status === 'closed' ? 'closed' : ''}" data-job-url="${escape(job.applyUrl || job.url)}">
    <div class="job-top"><span class="company">${escape(job.company)} · ${escape(job.source)}</span><div class="badges">${job.isNew ? '<span class="badge new">new</span>' : ''}${decision ? `<span class="badge decision-${escape(decision.code)}">${escape(decision.label)}</span>` : ''}${application ? `<span class="badge path-${escape(application.kind)}">${escape(application.label)}</span>` : ''}<span class="badge verification-badge ${escape(status)}">${escape(badge)}</span></div></div>
    <h3>${escape(job.title)}</h3>
    <div class="job-meta">${escape(job.location)}<br>published ${escape(age)}${job.salary ? ` · ${escape(job.salary)}` : ''}${job.closesAt ? ` · closes ${escape(new Date(job.closesAt).toLocaleDateString(undefined, {month: 'short', day: 'numeric'}))}` : ''}</div>
    <div class="score-row"><strong>${score}</strong><span>strategic match</span>${breakdown ? `<i>title ${breakdown.title} · evidence ${breakdown.resume} · location ${breakdown.location} · apply ${breakdown.application ?? '—'} · fresh ${breakdown.freshness}</i>` : ''}</div>
    <div class="matchbar" aria-label="${score}% resume match"><i style="width:${Math.max(3, Math.min(score, 100))}%"></i></div>
    ${outcomeLearning ? `<p class="learning-nudge">${escape(outcomeLearning.explanation)} Evidence: ${escape(outcomeLearning.evidence.join(', '))}</p>` : ''}
    <div class="match-copy">${reasons.length ? reasons.map((reason) => `<span>${escape(reason)}</span>`).join('') : (skills ? `matched: ${escape(skills)}` : 'No explicit skill overlap found')}${confidence ? `<small>${escape(confidence.level)} source confidence</small>` : ''}</div>
    ${qualifications.length ? `<details class="qualification-matrix"><summary>Requirement check · ${job.match.qualifications.counts.met} met · ${job.match.qualifications.counts.uncertain} uncertain · ${job.match.qualifications.counts.missing} missing</summary>${qualifications.map((item) => `<div class="qualification ${escape(item.status)}"><strong>${escape(item.status)} · ${escape(item.importance)}</strong><span>${escape(item.label)}</span><p>posting: ${escape(item.postingEvidence || 'evidence unavailable')}<br>candidate: ${escape(item.candidateEvidence || 'evidence unavailable')}<br>${escape(item.explanation)}</p></div>`).join('')}</details>` : ''}
    ${risks.length ? `<div class="fit-risks"><strong>Review before applying</strong>${risks.map((risk) => `<p>${escape(risk)}</p>`).join('')}</div>` : ''}
    <details class="job-description"><summary>Read job description</summary><p>${escape(job.description || 'The source did not provide a description. Open the posting to review it.')}</p></details>
    ${verificationEvidence}
    ${status === 'blocked' ? '<div class="browser-handoff"><strong>Browser check needed</strong><p>Open the posting in your browser. If a human check appears, complete it; if the job renders normally, continue immediately. Then choose <em>Verify current job page</em> in the paired ClearLead extension.</p></div>' : ''}
    <div class="job-actions">${actions}<a class="text-link" href="${escape(sourceUrl)}" ${sourceUrl === '#verify-panel' ? '' : 'target="_blank" rel="noreferrer"'}>open source ↗</a></div>
  </article>`;
}

function verificationEvidenceMarkup(check, {allowSave = false, queue = false, open = false} = {}) {
  const checked = check.checkedAt && Number.isFinite(Date.parse(check.checkedAt)) ? new Date(check.checkedAt).toLocaleString() : 'timestamp unavailable';
  const status = Number.isInteger(check.httpStatus) ? `HTTP ${check.httpStatus}` : 'HTTP status unavailable';
  const finalUrl = safeHttpUrl(check.finalUrl || check.url) ? check.finalUrl || check.url : '';
  const source = check.source ? escape(check.source) : 'pasted source';
  const method = check.verificationMethod ? escape(check.verificationMethod) : 'direct source check';
  const signals = Array.isArray(check.signals) && check.signals.length ? escape(check.signals.join(' + ')) : 'none recorded';
  const save = allowSave && check.verificationId ? `<button class="button primary" data-save="${escape(check.verificationId)}">Save verified lead</button>` : '';
  return `<details class="verification-evidence${queue ? ' lead-evidence' : ''}"${open ? ' open' : ''}><summary>Review verification evidence</summary><div class="verification-evidence-body"><p><strong>${escape(check.status || 'inconclusive')}</strong> · ${escape(checked)} · ${escape(status)}<br>source: ${source}<br>method: ${method}<br>signals: ${signals}</p><p>${escape(check.reason || 'No verification rationale was recorded.')}</p>${finalUrl ? `<a class="text-link evidence-url" href="${escape(finalUrl)}" target="_blank" rel="noreferrer">${escape(finalUrl)} ↗</a>` : '<p class="quiet">No safe final URL was recorded.</p>'}${save}</div></details>`;
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
  container.querySelectorAll('[data-kit]').forEach((button) => button.addEventListener('click', () => createApplicationKit(button.dataset.kit, button)));
  container.querySelectorAll('[data-resume]').forEach((button) => button.addEventListener('click', () => makeCustomResume(button.dataset.resume, button)));
  container.querySelectorAll('[data-autofill]').forEach((button) => button.addEventListener('click', () => prepareAutofill(button.dataset.autofill, button)));
  container.querySelectorAll('[data-mark-applied]').forEach((button) => button.addEventListener('click', () => markLeadApplied(button.dataset.markApplied, button)));
}

async function runVerification(discoveredUrl, metadata = {}) {
  if (verifying) return;
  verifying = true;
  setVerificationBusy(true);
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
  } finally {
    verifying = false;
    setVerificationBusy(false);
  }
}

function setVerificationBusy(busy) {
  const primary = document.querySelector('#verify');
  primary.disabled = busy;
  primary.textContent = busy ? 'Checking source…' : 'Verify live';
  document.querySelectorAll('[data-verify-url]').forEach((button) => { button.disabled = busy; });
}

function renderResult(check) {
  updateJobCard(check);
  result.className = `result ${check.status || 'inconclusive'}`;
  result.innerHTML = verificationEvidenceMarkup(check, {open: true});
  if (check.status === 'live') {
    const tailorAction = check.title && check.trustedJobMetadata !== false
      ? `<button class="button ghost" data-resume="${escape(check.verificationId)}">Make custom resume</button><button class="button ghost" data-autofill="${escape(check.verificationId)}">Prepare application</button>`
      : '<span class="quiet">Tailoring is available for roles found through ranked search.</span>';
    result.insertAdjacentHTML('beforeend', `<p class="quiet">Review the evidence above, then explicitly decide whether this lead belongs in your local queue.</p><div class="result-actions"><button class="button primary" data-save="${escape(check.verificationId)}">Save verified lead</button>${tailorAction}</div>`);
    wireJobActions(result);
  } else if (check.status === 'blocked' || check.status === 'inconclusive') {
    if (check.status === 'blocked') {
      const browserUrl = safeHttpUrl(check.finalUrl || check.url) ? check.finalUrl || check.url : '';
      const connected = extensionReady();
      result.insertAdjacentHTML('beforeend', `<div class="browser-handoff"><strong>${connected ? 'Extension connected — browser check ready' : 'Browser handoff'}</strong><p>Open the source. If a human check appears, complete it yourself; if the posting renders normally, continue immediately. On that job tab, open the ClearLead extension and choose <em>Verify current job page</em>.</p>${connected && browserUrl ? `<a class="button primary" href="${escape(browserUrl)}" target="_blank" rel="noreferrer">Open source in browser</a>` : '<button class="button ghost" id="show-extension-setup">Set up browser verification</button>'}</div>`);
    }
    result.insertAdjacentHTML('beforeend', `<p class="quiet">Nothing was saved. Choose what happens next.</p>${actionMarkup(check.finalUrl || check.url)}`);
    wireOutcomeActions(check.finalUrl || check.url);
    document.querySelector('#show-extension-setup')?.addEventListener('click', () => document.querySelector('#extension-setup').scrollIntoView({behavior: 'smooth', block: 'center'}));
  }
}

function extensionReady() {
  const pairing = appState?.extensionPairing;
  return pairing?.state === 'connected' && pairing.connected === true && !pairing.updateRequired;
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
    const container = button.closest('.job-card, .result') || result;
    container.querySelector('.save-error')?.remove();
    container.insertAdjacentHTML('beforeend', `<p class="quiet save-error">${escape(error.message)}</p>`);
  }
}

async function makeCustomResume(verificationId, button) {
  return createTailoredDraft(verificationId, button);
}

async function createTailoredDraft(verificationId, button) {
  button.disabled = true;
  button.textContent = 'Building resume…';
  tailorOutput.className = 'tailor-output active';
  tailorOutput.setAttribute('aria-live', 'polite');
  tailorOutput.innerHTML = `<div class="studio-loading"><span class="studio-orbit" aria-hidden="true"></span><div><p class="eyebrow">resume studio</p><h3>Building your grounded version live…</h3><p>Matching verified job language to evidence already in your resume. Unsupported claims stay out.</p></div></div>`;
  tailorOutput.scrollIntoView({behavior: 'smooth', block: 'start'});
  try {
    const draft = await requestJson('/api/tailor', {method: 'POST', body: JSON.stringify({verificationId})});
    renderResumeStudio(draft, verificationId);
    tailorOutput.scrollIntoView({behavior: 'smooth', block: 'center'});
    button.textContent = 'Open resume studio';
    button.disabled = false;
  } catch (error) {
    tailorOutput.innerHTML = `<strong>${escape(error.message)}</strong><p class="quiet">Verify the role again, then retry. Nothing was submitted.</p>`;
    button.disabled = false;
    button.textContent = 'Retry custom resume';
  }
}

function renderResumeStudio(draft, verificationId) {
  const suggestedName = resumeFileStem(`${draft.company || 'company'}-${draft.title || 'role'}-resume`);
  const matched = draft.matchedTerms || [];
  const absent = draft.absentTerms || [];
  const requirementMatrix = draft.requirementMatrix || {items: [], counts: {met: 0, uncertain: 0, missing: 0, preferredMissing: 0}};
  const changes = draft.changes || [];
  tailorOutput.innerHTML = `<section class="resume-studio" data-draft-id="${escape(draft.id)}" role="region" aria-labelledby="studio-title-${escape(draft.id)}" tabindex="-1">
    <header class="studio-head">
      <div><p class="eyebrow">resume studio / grounded</p><h3 id="studio-title-${escape(draft.id)}">${escape(draft.title || 'Tailored resume')}</h3><p>${escape(draft.company || 'Verified employer')} · built from your saved evidence</p></div>
      <span class="studio-ready"><i></i> PDF ready</span>
    </header>
    <div class="studio-grid">
      <aside class="studio-controls">
        <div class="studio-step"><span>01</span><div><strong>Name this version</strong><p>This name is used when you download or save it.</p></div></div>
        <label class="studio-name-label" for="resume-name-${escape(draft.id)}">Resume filename</label>
        <div class="studio-filename"><input id="resume-name-${escape(draft.id)}" value="${escape(suggestedName)}" maxlength="120" autocomplete="off"><b>.pdf</b></div>
        <a class="button primary studio-pdf" data-studio-pdf href="${escape(namedDownloadUrl(draft.pdfUrl, suggestedName))}">Download polished PDF</a>
        <a class="button ghost" data-studio-docx href="${escape(namedDownloadUrl(draft.docxUrl, suggestedName))}">Download ATS-safe DOCX</a>
        <div class="studio-step"><span>02</span><div><strong>Choose what happens next</strong><p>You stay in control of every destination.</p></div></div>
        <button class="studio-choice" data-studio-default><i>↻</i><span><strong>Save as my default</strong><small>Use this version for future matching</small></span></button>
        <button class="studio-choice featured" data-studio-apply><i>↗</i><span><strong>Use for this application</strong><small>Select this PDF, then open the employer flow</small></span></button>
        ${aiState.configured ? `<button class="studio-choice" data-studio-ai><i>✦</i><span><strong>Build audited AI kit</strong><small>Ask ${escape(providerName(aiState.provider))} to prioritize evidence</small></span></button>` : ''}
        <div class="studio-ai-output" data-studio-ai-output aria-live="polite"></div>
        <a class="studio-secondary" data-studio-markdown href="${escape(namedDownloadUrl(draft.downloadUrl, suggestedName))}">Download editable Markdown</a>
        <p class="studio-boundary">ClearLead prepares the file and application page. It never emails an employer or clicks Submit.</p>
        <div class="studio-message" data-studio-message aria-live="polite"></div>
      </aside>
      <div class="studio-preview-wrap">
        <div class="studio-preview-meta"><span>LIVE PREVIEW</span><span>LETTER · ATS SAFE</span></div>
        <article class="resume-paper">${resumePreviewMarkup(draft.preview)}</article>
      </div>
    </div>
    <footer class="grounding-drawer">
      <div><span class="grounding-score">${matched.length}</span><p><strong>matched signals</strong><br>${escape(matched.slice(0, 10).join(' · ') || 'Review fit manually')}</p></div>
      <div><span class="grounding-score gap">${absent.length}</span><p><strong>gaps kept out</strong><br>${escape(absent.slice(0, 8).join(' · ') || 'No obvious gaps detected')}</p></div>
    </footer>
    ${requirementMatrix.items.length ? `<details class="qualification-matrix"><summary>Tailoring requirement matrix · ${requirementMatrix.counts.met} met · ${requirementMatrix.counts.uncertain} uncertain · ${requirementMatrix.counts.missing} required missing · ${requirementMatrix.counts.preferredMissing} preferred missing</summary>${requirementMatrix.items.map((item) => `<div class="qualification ${escape(item.status)}"><strong>${escape(item.status)} · ${escape(item.importance)}</strong><span>${escape(item.label)}</span><p>posting: ${escape(item.postingEvidence || 'evidence unavailable')}<br>candidate: ${escape(item.candidateEvidence || 'evidence unavailable')}<br>${escape(item.explanation)}</p></div>`).join('')}</details>` : ''}
    <details class="qualification-matrix"><summary>Explain every resume change · ${changes.length} recorded</summary>${changes.length ? changes.map((change) => `<div class="qualification ${escape(change.type)}"><strong>${escape(change.type)}</strong><span>${change.sourceLine ? `source line ${escape(change.sourceLine)} · position ${escape(change.from)} → ${escape(change.to)}` : 'document cleanup'}</span><p>${escape(change.reason)}</p></div>`).join('') : '<div class="qualification"><span>No line order or cleanup changes were needed.</span></div>'}</details>
  </section>`;

  const studio = tailorOutput.querySelector('.resume-studio');
  const input = studio.querySelector('.studio-filename input');
  const pdfLink = studio.querySelector('[data-studio-pdf]');
  const docxLink = studio.querySelector('[data-studio-docx]');
  const markdownLink = studio.querySelector('[data-studio-markdown]');
  const syncNames = () => {
    const name = resumeFileStem(input.value);
    pdfLink.href = namedDownloadUrl(draft.pdfUrl, name);
    docxLink.href = namedDownloadUrl(draft.docxUrl, name);
    markdownLink.href = namedDownloadUrl(draft.downloadUrl, name);
  };
  input.addEventListener('input', syncNames);
  studio.querySelector('[data-studio-default]').addEventListener('click', (event) => saveTailoredAsDefault(draft, input, event.currentTarget));
  studio.querySelector('[data-studio-apply]').addEventListener('click', (event) => prepareAutofill(verificationId, event.currentTarget, {id: draft.id, filename: `${resumeFileStem(input.value)}.pdf`}));
  studio.querySelector('[data-studio-ai]')?.addEventListener('click', (event) => createApplicationKit(verificationId, event.currentTarget, studio.querySelector('[data-studio-ai-output]')));
  tailorOutput.setAttribute('aria-live', 'off');
  studio.focus({preventScroll: true});
}

async function saveTailoredAsDefault(draft, input, button) {
  const filename = `${resumeFileStem(input.value)}.md`;
  if (!window.confirm(`Make ${filename} your default resume for future searches and tailored versions?`)) return;
  button.disabled = true;
  const message = button.closest('.studio-controls').querySelector('[data-studio-message]');
  message.className = 'studio-message active';
  message.textContent = 'Saving locally…';
  try {
    const saved = await requestJson(`/api/tailored/${encodeURIComponent(draft.id)}/default`, {method: 'POST', body: JSON.stringify({filename})});
    message.className = 'studio-message active ok';
    message.innerHTML = `${escape(saved.message)}${saved.undoId ? ' <button class="studio-undo" type="button">Undo</button>' : ''}`;
    if (saved.undoId) message.querySelector('.studio-undo').addEventListener('click', (event) => restoreDefaultResume(saved.undoId, message, event.currentTarget, button));
    button.querySelector('strong').textContent = 'Saved as default';
    button.querySelector('small').textContent = 'Future matching will use this version';
    await loadState({autoSearch: false});
  } catch (error) {
    message.className = 'studio-message active error';
    message.textContent = error.message;
    button.disabled = false;
  }
}

async function restoreDefaultResume(undoId, message, undoButton, defaultButton) {
  undoButton.disabled = true;
  try {
    const restored = await requestJson('/api/resume/default/restore', {method: 'POST', body: JSON.stringify({undoId})});
    message.className = 'studio-message active ok';
    message.textContent = restored.message;
    defaultButton.disabled = false;
    defaultButton.querySelector('strong').textContent = 'Save as my default';
    defaultButton.querySelector('small').textContent = 'Use this version for future matching';
    await loadState({autoSearch: false});
  } catch (error) {
    message.className = 'studio-message active error';
    message.textContent = error.message;
  }
}

function namedDownloadUrl(url, name) {
  return `${url}?name=${encodeURIComponent(resumeFileStem(name))}`;
}

function resumeFileStem(value) {
  return String(value || 'tailored-resume').replace(/\.(?:pdf|md)$/i, '').replace(/[^a-z0-9_. -]/gi, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 120) || 'tailored-resume';
}

function resumePreviewMarkup(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const commonSections = /^(summary|profile|professional summary|experience|work experience|employment|education|skills|technical skills|certifications|projects|selected projects|awards|volunteer experience):?$/i;
  let output = '';
  let listOpen = false;
  let firstContent = true;
  const closeList = () => { if (listOpen) { output += '</ul>'; listOpen = false; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const bullet = line.match(/^(?:[-*+•]|\d+[.)])\s+(.+)$/);
    if (bullet) {
      if (!listOpen) { output += '<ul>'; listOpen = true; }
      output += `<li>${escape(bullet[1])}</li>`;
      firstContent = false;
      continue;
    }
    closeList();
    if (heading) {
      const level = heading[1].length === 1 && firstContent ? 'h1' : 'h2';
      output += `<${level}>${escape(heading[2])}</${level}>`;
    } else if (commonSections.test(line)) output += `<h2>${escape(line.replace(/:$/, ''))}</h2>`;
    else if (firstContent && line.length <= 72) output += `<h1>${escape(line)}</h1>`;
    else output += `<p>${escape(line)}</p>`;
    firstContent = false;
  }
  closeList();
  return output;
}

async function createApplicationKit(verificationId, button, embeddedOutput = null) {
  if (!aiState.configured) {
    document.querySelector('#ai-setup').scrollIntoView({behavior: 'smooth'});
    showAIMessage('Add an OpenRouter, OpenAI, or Anthropic key first. The local tailor remains available without one.', 'error');
    return;
  }
  const approved = window.confirm(`Send your saved resume and this verified job description to ${providerName(aiState.provider)} (${aiState.model}) to build a reviewable application kit? ClearLead will not submit anything.`);
  if (!approved) return;
  const output = embeddedOutput || tailorOutput;
  button.disabled = true;
  const label = button.querySelector('strong');
  const detail = button.querySelector('small');
  if (label) label.textContent = 'Building audited kit…'; else button.textContent = 'Building & auditing…';
  if (detail) detail.textContent = 'Selecting only grounded evidence';
  output.className = embeddedOutput ? 'studio-ai-output active' : 'tailor-output active';
  output.innerHTML = '<p class="quiet">Selecting and prioritizing verbatim resume evidence for the resume, fit report, cover-letter evidence draft, and interview prep.</p>';
  try {
    const consent = await requestJson('/api/ai/consent', {method: 'POST', body: JSON.stringify({verificationId})});
    const kit = await requestJson('/api/ai/kit', {method: 'POST', body: JSON.stringify({verificationId, consentId: consent.consentId})});
    const labels = {'resume':'Editable resume', 'fit-report':'Fit report', 'cover-letter':'Cover letter', 'interview-prep':'Interview prep', 'claim-audit':'Claim audit'};
    const downloads = `<a class="button primary" href="${escape(kit.pdfUrl)}">Download AI resume PDF</a><a class="button ghost" href="${escape(kit.docxUrl)}">Download AI resume DOCX</a>` + Object.entries(kit.downloads).map(([name, url]) => `<a class="button ghost" href="${escape(url)}">${escape(labels[name] || name)}</a>`).join('');
    output.innerHTML = `<div class="tailor-head"><div><p class="eyebrow">audited application kit ready</p><h3>${escape(providerName(kit.provider))} · ${escape(kit.model)}</h3></div><div class="kit-downloads">${downloads}</div></div>
      <div class="audit-strip"><strong>${kit.audit.accepted}</strong><span>source selections accepted</span><strong>${kit.audit.rejected}</strong><span>model-written claims rejected</span></div>
      <p class="quiet">Priority language: ${escape(kit.matchedTerms.join(', ') || 'none returned')}<br>Gaps kept out of the resume: ${escape(kit.gaps.join(', ') || 'none returned')}</p>
      <button class="button primary" data-ai-use type="button"><strong>Use this AI version</strong><small>Select its PDF for this application</small></button>
      <details><summary>Preview audited resume</summary><pre>${escape(kit.preview)}</pre></details>`;
    output.querySelector('[data-ai-use]').addEventListener('click', (event) => prepareAutofill(verificationId, event.currentTarget, {kitId: kit.id, filename: `${resumeFileStem(`${kit.company || 'company'}-${kit.title || 'role'}-AI-resume`)}.pdf`}));
    output.scrollIntoView({behavior: 'smooth', block: 'nearest'});
    if (label) label.textContent = 'Audited AI kit ready'; else button.textContent = 'Custom resume ready';
    if (detail) detail.textContent = 'Downloads available below';
  } catch (error) {
    output.innerHTML = `<strong>${escape(error.message)}</strong><p class="quiet">No kit was saved and nothing was submitted. You can retry or keep using the local grounded resume above.</p>`;
    button.disabled = false;
    if (label) label.textContent = 'Retry audited AI kit'; else button.textContent = 'Retry custom resume';
    if (detail) detail.textContent = 'The local Resume Studio is still available';
  }
}

async function prepareAutofill(verificationId, button, resumeDraft = null) {
  button.disabled = true;
  const label = button.querySelector('strong');
  const detail = button.querySelector('small');
  if (label) label.textContent = 'Preparing application…'; else button.textContent = 'Preparing…';
  try {
    const resumeSelection = resumeDraft ? {...(resumeDraft.kitId ? {kitId: resumeDraft.kitId} : {draftId: resumeDraft.id}), filename: resumeDraft.filename} : {};
    const pack = await requestJson('/api/application/prepare', {method: 'POST', body: JSON.stringify({verificationId, ...resumeSelection})});
    showAutofillPack(pack, {scroll: true});
    if (label) label.textContent = 'Application handoff ready'; else button.textContent = 'Application ready';
    if (detail) detail.textContent = 'Download the PDF and open the employer flow below';
  } catch (error) {
    autofillOutput.className = 'tailor-output active';
    autofillOutput.innerHTML = `<strong>${escape(error.message)}</strong><p class="quiet">Save your application identity, pair the extension, or verify the role again, then retry.</p>`;
    button.disabled = false;
    if (label) label.textContent = 'Retry application handoff'; else button.textContent = 'Retry autofill';
    if (detail) detail.textContent = 'Nothing was sent';
  }
}

function showAutofillPack(pack, {scroll = false, resumed = false} = {}) {
  const resumeHandoff = pack.resume ? `<div class="application-resume"><div><strong>Selected resume</strong><span>${escape(pack.resume.filename)}</span></div><a class="button ghost" href="${escape(pack.resume.pdfUrl)}">Download selected PDF</a></div>` : '<p class="quiet">No tailored resume is attached to this handoff. Choose and upload a resume on the employer page.</p>';
  autofillOutput.className = 'tailor-output active';
  autofillOutput.innerHTML = `<div class="tailor-head"><div><p class="eyebrow">${resumed ? 'application run resumed' : 'application copilot ready'}</p><h3>${escape(pack.job.company)} · ${escape(pack.job.title)}</h3></div><a class="button primary" href="${escape(pack.job.applicationUrl)}" target="_blank" rel="noreferrer">Open verified application ↗</a></div>${resumeHandoff}<p class="quiet">Run ${escape(pack.run.id.slice(0, 8))} is saved locally. Open the verified application, then click the ClearLead extension icon. Its persistent side panel fills repeatable fields, attaches the selected resume when you approve it, and guides every step until your final review. ClearLead never clicks Submit.</p>`;
  appState = {...(appState || {}), autofillPack: pack, applicationRuns: [pack.run, ...((appState?.applicationRuns || []).filter((run) => run.id !== pack.run.id))]};
  renderPreparedApplications(appState.applicationRuns);
  updateJourney(appState);
  if (scroll) autofillOutput.scrollIntoView({behavior: 'smooth', block: 'center'});
}

function showRecoverableApplication(data) {
  const runs = data.applicationRuns || [];
  if (data.autofillPack) {
    const run = runs.find((item) => item.id === data.autofillPack.id);
    if (run) showAutofillPack({...data.autofillPack, run});
    return;
  }
  const run = runs.find((item) => item.status !== 'complete');
  if (!run) return;
  autofillOutput.className = 'tailor-output active';
  autofillOutput.innerHTML = `<div class="tailor-head"><div><p class="eyebrow">saved application run</p><h3>${escape(run.job.company)} · ${escape(run.job.title)}</h3></div><button class="button primary" data-resume-run="${escape(run.id)}">Revalidate and resume</button></div><p class="quiet">Last state: ${escape(run.status.replaceAll('_', ' '))}. ClearLead will recheck the employer page before reissuing this run to the extension.</p>`;
  autofillOutput.querySelector('[data-resume-run]').addEventListener('click', (event) => resumeSavedApplication(run.id, event.currentTarget));
}

async function resumeSavedApplication(runId, button) {
  button.disabled = true;
  button.textContent = 'Revalidating employer page…';
  try {
    const pack = await requestJson(`/api/application/runs/${encodeURIComponent(runId)}/resume`, {method: 'POST', body: '{}'});
    showAutofillPack(pack, {scroll: true, resumed: true});
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Retry revalidation';
    autofillOutput.insertAdjacentHTML('beforeend', `<p class="quiet"><strong>${escape(error.message)}</strong></p>`);
  }
}

function updateJobCard(check) {
  const card = [...document.querySelectorAll('.job-card')].find((item) => item.dataset.jobUrl === check.url);
  if (!card || !check.status) return;
  const badge = card.querySelector('.verification-badge');
  const verifyButton = card.querySelector('[data-verify-url]');
  const actions = card.querySelector('.job-actions');
  card.querySelector('.verification-evidence')?.remove();
  actions?.insertAdjacentHTML('beforebegin', verificationEvidenceMarkup(check, {allowSave: check.status === 'live'}));
  badge.className = `badge verification-badge ${check.status}`;
  if (check.status === 'live') {
    badge.textContent = 'verified live';
    card.classList.add('verified');
    if (actions && check.verificationId) {
      actions.innerHTML = `<button class="button ghost" data-resume="${escape(check.verificationId)}">Make custom resume</button><button class="button ghost" data-autofill="${escape(check.verificationId)}">Prepare application</button><a class="text-link" href="${escape(check.finalUrl || check.url)}" target="_blank" rel="noreferrer">open source ↗</a>`;
      wireJobActions(card);
    }
  } else if (check.status === 'closed') {
    badge.textContent = 'verified closed';
    card.classList.add('closed');
    if (verifyButton) { verifyButton.removeAttribute('data-verify-url'); verifyButton.disabled = true; verifyButton.textContent = 'Closed'; }
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
  document.querySelector('#preferences').value = (profile.preferences || []).join(', ');
  document.querySelector('#must-haves').value = (profile.mustHaves || []).join(', ');
  readiness.className = state.ready ? 'readiness ready' : 'readiness not-ready';
  readiness.textContent = state.message;
}

function showSearchConfig(config) {
  if (config.smartPrompt) document.querySelector('#smart-search').value = config.smartPrompt;
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
    ? queue.map((lead) => {
      const target = safeHttpUrl(lead.finalUrl || lead.url) ? lead.finalUrl || lead.url : '';
      const link = target ? `<a href="${escape(target)}" target="_blank" rel="noreferrer">${escape(lead.title || target)}</a>` : `<a href="#verify-panel">${escape(lead.title || 'Saved lead')}</a>`;
      const reverify = target ? `<button class="button ghost" data-verify-url="${escape(target)}">Reverify source</button>` : '<span class="quiet">No safe source URL is available; discard this legacy entry from local data if it is no longer useful.</span>';
      const alreadyApplied = (appState?.applications || []).some((application) => application.leadId === lead.id || comparableUrl(application.job?.url) === comparableUrl(target));
      const appliedAction = alreadyApplied
        ? '<a class="button ghost" href="#applied">View in Applied</a>'
        : lead.title && lead.company
          ? `<button class="button primary" data-mark-applied="${escape(lead.id)}">I applied</button>`
          : '<a class="button primary" href="#applied">Add application details</a>';
      return `<article class="lead"><i class="lead-status"></i><div>${link}<p class="why">${lead.company ? `${escape(lead.company)} · ` : ''}${escape(lead.reason)}</p>${verificationEvidenceMarkup(lead, {queue: true})}<div class="lead-actions">${appliedAction}${reverify}</div></div><time>${relativeTime(lead.savedAt)}</time></article>`;
    }).join('')
    : '<div class="empty-state"><strong>Your queue is clear.</strong><p>Search a role, verify it live, then add it here for review.</p></div>';
  wireJobActions(leads);
}

const OUTCOME_LABELS = {
  applied: 'Applied', recruiter_contact: 'Recruiter contact', screening: 'Screening', assessment: 'Assessment', interview: 'Interview',
  final_interview: 'Final interview', offer: 'Offer', hired: 'Hired', rejected: 'Rejected', withdrawn: 'Withdrew',
  offer_declined: 'Offer declined', no_response: 'No response as of today',
};
const OUTCOME_REASONS = {
  unknown: 'Unknown / not provided', experience: 'Experience mismatch', skills: 'Skill mismatch', role_fit: 'Role fit', location: 'Location',
  compensation: 'Compensation', authorization: 'Work authorization', resume: 'Resume / screening', assessment: 'Assessment', interview: 'Interview',
  timing: 'Timing', position_closed: 'Position closed', internal_candidate: 'Internal candidate', other: 'Other',
};
const REACHED_LABELS = {application: 'Application only', screening: 'Recruiter / screen', interview: 'Interview', final_interview: 'Final interview', offer: 'Offer'};

function renderApplications(items = [], learning = {}) {
  document.querySelector('#applied-total').textContent = items.length;
  document.querySelector('#applied-responses').textContent = learning.responses || 0;
  document.querySelector('#applied-interviews').textContent = learning.interviews || 0;
  document.querySelector('#applied-offers').textContent = learning.offers || 0;
  const toggle = document.querySelector('#outcome-learning-toggle');
  toggle.checked = learning.rankingEnabled !== false;
  const title = document.querySelector('#learning-title');
  const copy = document.querySelector('#learning-copy');
  title.textContent = learning.mode === 'active' ? 'Calibration active' : learning.mode === 'paused' ? 'Ranking influence paused' : 'Observing outcomes';
  copy.textContent = learning.mode === 'active'
    ? `Using ${learning.sampleSize} comparable outcomes with a capped local adjustment. Hard eligibility and qualification gates never change.`
    : learning.mode === 'paused'
      ? 'Your timeline remains local and intact, but it will not adjust future ranks.'
      : `${learning.sampleSize || 0}/${learning.minimumSamples || 20} comparable outcomes and ${learning.responses || 0}/${learning.minimumResponses || 5} responses recorded. Signals remain in shadow mode until the evidence gate is met.`;
  document.querySelector('#learning-signals').innerHTML = (learning.signals || []).slice(0, 6).map((signal) => `<span title="${escape(`${signal.responses} responses from ${signal.samples} comparable outcomes`)}">${escape(signal.label)} · ${signal.samples}</span>`).join('') || '<span>Waiting for confirmed employer outcomes</span>';
  applications.innerHTML = items.length ? items.map(applicationCard).join('') : '<div class="empty-state"><strong>No applied jobs yet.</strong><p>Completed ClearLead applications appear here automatically. You can also mark a saved lead as applied or add past history above.</p></div>';
  renderPreparedApplications(appState?.applicationRuns || []);
  if (!document.querySelector('#past-job-date').value) document.querySelector('#past-job-date').value = new Date().toISOString().slice(0, 10);
}

function renderPreparedApplications(runs = []) {
  const container = document.querySelector('#prepared-applications');
  if (!container) return;
  const prepared = runs.filter((run) => run.status !== 'complete');
  document.querySelector('#prepared-total').textContent = `${prepared.length} ready for review`;
  container.innerHTML = prepared.length ? prepared.map(preparedApplicationCard).join('') : '<div class="empty-state"><strong>No applications waiting.</strong><p>When you prepare a verified job, its employer handoff will stay visible here until submission is confirmed.</p></div>';
  container.querySelectorAll('[data-resume-run]').forEach((button) => button.addEventListener('click', (event) => resumeSavedApplication(event.currentTarget.dataset.resumeRun, event.currentTarget)));
}

function preparedApplicationCard(run) {
  const job = run.job || {};
  const applicationUrl = safeHttpUrl(job.applicationUrl) ? job.applicationUrl : safeHttpUrl(job.url) ? job.url : '';
  const status = String(run.status || 'prepared').replaceAll('_', ' ');
  const resume = run.resume || {};
  return `<article class="panel application-card prepared-application-card" data-run-id="${escape(run.id)}">
    <div class="application-card-head"><div><p class="eyebrow">prepared · not submitted</p><h3>${escape(job.title || 'Prepared application')}</h3><p>${escape(job.company || 'Company not recorded')} · ${escape(job.location || 'Location not recorded')}</p></div><span class="outcome-badge prepared">${escape(status)}</span></div>
    <div class="application-facts"><span>No employer confirmation</span><span>${resume.filename ? `resume · ${escape(resume.filename)}` : 'resume · not recorded'}</span></div>
    ${applicationResumeActions(resume)}
    <div class="prepared-actions">${applicationUrl ? `<a class="button primary" href="${escape(applicationUrl)}" target="_blank" rel="noreferrer">Continue application ↗</a>` : ''}<button class="button ghost" type="button" data-resume-run="${escape(run.id)}">Revalidate &amp; resume copilot</button></div>
    <p class="quiet">Review the employer’s remaining questions and click its final Submit button yourself. Then use the ClearLead extension to confirm the employer completion page so this moves into Actually applied.</p>
  </article>`;
}

function applicationCard(application) {
  const job = application.job || {};
  const url = safeHttpUrl(job.url) ? job.url : '';
  const stage = OUTCOME_LABELS[application.currentStage] || 'Applied';
  const events = (application.events || []).slice(-4).reverse();
  const snapshot = application.decisionSnapshot;
  const resume = application.resume?.filename ? `<span>resume · ${escape(application.resume.filename)}</span>` : '<span>resume · not recorded</span>';
  const resumeActions = applicationResumeActions(application.resume);
  const evidence = application.evidence === 'employer_completion' ? 'employer confirmation detected' : 'confirmed by you';
  const updateLabel = ['offer', 'hired', 'rejected', 'withdrawn', 'offer_declined'].includes(application.currentStage) ? 'Add correction or new result' : 'Mark employer update';
  return `<article class="panel application-card" data-application-id="${escape(application.id)}">
    <div class="application-card-head"><div><p class="eyebrow">${escape(evidence)}</p><h3>${url ? `<a href="${escape(url)}" target="_blank" rel="noreferrer">${escape(job.title || 'Applied role')} ↗</a>` : escape(job.title || 'Applied role')}</h3><p>${escape(job.company || 'Company not recorded')} · ${escape(job.location || 'Location not recorded')}</p></div><span class="outcome-badge ${escape(application.currentStage)}">${escape(stage)}</span></div>
    <div class="application-facts"><span>applied ${escape(new Date(application.appliedAt).toLocaleDateString())}</span><span>${escape(job.source || 'manual history')}</span>${resume}</div>
    ${resumeActions}
    ${snapshot ? `<details class="decision-snapshot"><summary>Original decision snapshot · ${snapshot.score} match</summary><p>Scorer: ${escape(snapshot.scorerVersion || 'legacy')} · raw ${snapshot.rawScore}<br>${snapshot.decision ? `${escape(snapshot.decision.label)} — ${escape(snapshot.decision.reason)}` : 'No original decision label was recorded.'}<br>Snapshot ${snapshot.descriptionHash ? 'includes a posting digest' : 'comes from a legacy run'}; it is never recomputed from a later resume.</p></details>` : '<p class="quiet">Legacy/manual application — no original score snapshot is available.</p>'}
    <div class="outcome-timeline">${events.map((event) => `<div><i></i><span><strong>${escape(OUTCOME_LABELS[event.type] || event.type)}</strong> · ${escape(new Date(event.at).toLocaleDateString())}${event.stageReached && event.type === 'rejected' ? ` · reached ${escape(REACHED_LABELS[event.stageReached] || event.stageReached)}` : ''}${event.reason && event.reason !== 'unknown' ? ` · ${escape(OUTCOME_REASONS[event.reason] || event.reason)}` : ''}${event.note ? `<small>${escape(event.note)}</small>` : ''}</span></div>`).join('')}</div>
    <details class="outcome-update"><summary>${escape(updateLabel)}</summary><div class="outcome-form">
      <div class="field"><label>Current result</label><select data-outcome-stage>${selectOptions(OUTCOME_LABELS, application.currentStage)}</select></div>
      <div class="field"><label>Furthest stage reached</label><select data-outcome-reached>${selectOptions(REACHED_LABELS, application.stageReached)}</select></div>
      <div class="field"><label>Reason <span>only if known</span></label><select data-outcome-reason>${selectOptions(OUTCOME_REASONS, application.outcomeReason || 'unknown')}</select></div>
      <div class="field span-2"><label>Private note <span>optional</span></label><input data-outcome-note maxlength="1000" placeholder="Record confirmed facts; generic rejection emails usually give no reason."></div>
      <button class="button primary" type="button" data-save-outcome="${escape(application.id)}">Save update</button>
    </div></details>
  </article>`;
}

function applicationResumeActions(resume = {}) {
  const id = resume.draftId || resume.kitId;
  if (!id || !resume.filename) return '';
  const base = resume.draftId ? `/api/tailored/${encodeURIComponent(id)}` : `/api/kits/${encodeURIComponent(id)}/resume`;
  const name = encodeURIComponent(String(resume.filename).replace(/\.[^.]+$/, ''));
  return `<div class="application-resume-links"><a class="button ghost" href="${base}/pdf?name=${name}&view=1" target="_blank" rel="noreferrer">View custom resume</a><a class="button ghost" href="${base}/pdf?name=${name}">Download PDF</a><a class="button ghost" href="${base}/docx?name=${name}">Download DOCX</a></div>`;
}

function selectOptions(labels, selected) {
  return Object.entries(labels).map(([value, label]) => `<option value="${escape(value)}"${value === selected ? ' selected' : ''}>${escape(label)}</option>`).join('');
}

async function markLeadApplied(leadId, button) {
  button.disabled = true;
  button.textContent = 'Recording…';
  try {
    const data = await requestJson('/api/applications', {method: 'POST', body: JSON.stringify({leadId, appliedAt: new Date().toISOString()})});
    applyApplicationsPayload(data);
    document.querySelector('#applied').scrollIntoView({behavior: 'smooth', block: 'start'});
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Retry I applied';
    button.insertAdjacentHTML('afterend', `<span class="quiet">${escape(error.message)}</span>`);
  }
}

async function addPastApplication() {
  const button = document.querySelector('#add-past-application');
  button.disabled = true;
  button.textContent = 'Adding…';
  try {
    const date = document.querySelector('#past-job-date').value;
    const data = await requestJson('/api/applications', {method: 'POST', body: JSON.stringify({
      title: value('#past-job-title'), company: value('#past-job-company'), url: value('#past-job-url'),
      appliedAt: date ? new Date(`${date}T12:00:00`).toISOString() : new Date().toISOString(), note: value('#past-job-note'),
    })});
    applyApplicationsPayload(data);
    if (data.saved) ['#past-job-title', '#past-job-company', '#past-job-url', '#past-job-note'].forEach((selector) => { document.querySelector(selector).value = ''; });
    button.textContent = data.saved ? 'Added' : 'Already recorded';
  } catch (error) {
    button.textContent = error.message;
  } finally {
    button.disabled = false;
    setTimeout(() => { button.textContent = 'Add to Applied'; }, 2200);
  }
}

async function saveApplicationOutcome(id, button) {
  const card = button.closest('.application-card');
  button.disabled = true;
  button.textContent = 'Saving locally…';
  try {
    const data = await requestJson(`/api/applications/${encodeURIComponent(id)}/outcome`, {method: 'POST', body: JSON.stringify({
      stage: card.querySelector('[data-outcome-stage]').value,
      stageReached: card.querySelector('[data-outcome-reached]').value,
      reason: card.querySelector('[data-outcome-reason]').value,
      note: card.querySelector('[data-outcome-note]').value,
      at: new Date().toISOString(),
    })});
    applyApplicationsPayload(data);
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Retry update';
    button.insertAdjacentHTML('afterend', `<span class="quiet">${escape(error.message)}</span>`);
  }
}

async function saveOutcomeLearningSetting(event) {
  const toggle = event.currentTarget;
  toggle.disabled = true;
  try {
    const data = await requestJson('/api/applications/learning', {method: 'POST', body: JSON.stringify({rankingEnabled: toggle.checked})});
    appState = {...(appState || {}), outcomeLearning: data.learning};
    renderApplications(appState.applications || [], data.learning);
  } catch {
    toggle.checked = !toggle.checked;
  } finally { toggle.disabled = false; }
}

function applyApplicationsPayload(data) {
  appState = {...(appState || {}), applications: data.applications || [], outcomeLearning: data.learning || {}};
  renderApplications(appState.applications, appState.outcomeLearning);
  renderQueue(appState.leads || []);
}

async function loadState({autoSearch = true} = {}) {
  try {
    const data = await requestJson('/api/leads');
    appState = data;
    showRuntimeReadiness(data.runtime);
    showResume(data.resume);
    showProfile(data.profile, data.readiness);
    showApplicationProfile(data.applicationProfile, data.applicationReadiness);
    renderExtensionPairing(data.extensionPairing || {state: data.extensionPaired ? 'stale' : 'unpaired', tokenActive: data.extensionPaired});
    showSearchConfig(data.searchConfig);
    renderQueue(data.leads);
    renderApplications(data.applications || [], data.outcomeLearning || {});
    showRecoverableApplication(data);
    updateJourney(data);
    if (data.searchStatus.lastRunAt) document.querySelector('#last-scan').textContent = `last scan ${relativeTime(data.searchStatus.lastRunAt)}`;
    const hasPreviousSearch = Boolean(data.searchStatus.lastRunAt);
    if (autoSearch && resumeReady && data.searchConfig.autoRefresh && hasPreviousSearch && document.querySelector('#smart-search').value.trim()) searchJobs({silent: true});
    else scheduleRefresh(data.searchConfig, {startTimer: resumeReady && hasPreviousSearch && Boolean(document.querySelector('#smart-search').value.trim())});
    try { showAI(await requestJson('/api/ai')); }
    catch (error) { showAI({configured: false}); showAIMessage(`${error.message} The core search is still available. Use Remove key to reset the optional vault.`, 'error'); }
  } catch (error) {
    leads.innerHTML = `<div class="empty-state"><strong>${escape(error.message)}</strong><p><button class="button ghost" id="retry-queue">Retry loading ClearLead</button></p></div>`;
    document.querySelector('#retry-queue').addEventListener('click', () => loadState());
  }
}

function updateJourney(state = {}) {
  const hasSearch = Boolean(state.searchStatus?.lastRunAt);
  const activeRun = state.autofillPack || (state.applicationRuns || []).find((run) => run.status !== 'complete');
  const hasTailoredResume = Boolean(activeRun?.resume || activeRun?.run?.resume);
  const steps = [
    ['resume', resumeReady, !resumeReady, resumeReady ? 'Ready locally' : 'Add your evidence'],
    ['search', hasSearch, resumeReady && !hasSearch, hasSearch ? 'Ranked matches ready' : 'Find strong matches'],
    ['tailor', hasTailoredResume, hasSearch && !hasTailoredResume, hasTailoredResume ? 'Resume selected' : 'Build the right resume'],
    ['apply', Boolean(activeRun), Boolean(activeRun), activeRun ? 'Continue in copilot' : 'Use the copilot'],
  ];
  for (const [name, done, active, label] of steps) {
    const node = document.querySelector(`#journey-${name}`);
    node.className = `${done && name !== 'apply' ? 'done' : ''} ${active ? 'active' : ''}`.trim();
    node.querySelector('small').textContent = label;
  }
  const primary = document.querySelector('#hero-primary');
  const copy = document.querySelector('#hero-copy');
  if (activeRun) {
    primary.href = '#autofill-output';
    primary.textContent = 'Continue my application';
    copy.textContent = 'Your application is prepared. Open the employer form and use the persistent ClearLead copilot to fill each step, attach the selected resume, and reach final review.';
  } else if (hasSearch) {
    primary.href = '#search-results';
    primary.textContent = 'Review my best matches';
    copy.textContent = 'Your ranked job pool is ready. Start with the strongest verified match, review its requirements, then build the tailored resume and application flow.';
  } else if (resumeReady) {
    primary.href = '#search';
    primary.textContent = 'Find my best matches';
    copy.textContent = 'Your resume is indexed locally. Describe the work you want once; ClearLead will reject bad fits, rank the strongest matches, and verify the best application paths.';
  } else {
    primary.href = '#resume';
    primary.textContent = 'Add my resume';
    copy.textContent = 'Start with your real experience. ClearLead keeps it local, rejects bad-fit roles, and uses only your evidence to tailor each application.';
  }
}

async function pollBrowserVerification() {
  try {
    const data = await requestJson('/api/browser-verification');
    const check = data.verification;
    if (!check?.captureId || check.captureId === lastBrowserCaptureId) return;
    lastBrowserCaptureId = check.captureId;
    current = check;
    if (/^https:\/\//i.test(check.finalUrl || '')) document.querySelector('#job-url').value = check.finalUrl;
    renderResult(check);
    result.scrollIntoView({behavior: 'smooth', block: 'center'});
  } catch {}
}

function showRuntimeReadiness(runtime = {}) {
  const status = document.querySelector('#runtime-status');
  const output = document.querySelector('#runtime-readiness');
  if (runtime.ready) {
    status.textContent = 'runtime ready · data stays local';
    output.className = 'runtime-readiness';
    output.innerHTML = '';
    return;
  }
  status.textContent = runtime.coreReady ? 'core ready · optional setup needed' : 'runtime blocked';
  output.className = 'runtime-readiness active';
  output.innerHTML = (runtime.issues || []).map((issue) => `<div><strong>${escape(issue.feature)}:</strong> ${escape(issue.message)}<br>Repair: <code>${escape(issue.repair)}</code></div>`).join('');
}

function readSearchConfig() {
  return {
    greenhouseBoards: list('#greenhouse-boards'), leverSites: list('#lever-sites'), ashbyBoards: list('#ashby-boards'), broadFeeds: list('#broad-feeds'),
    query: document.querySelector('#role-query').value.trim(), location: document.querySelector('#search-location').value.trim(),
    smartPrompt: document.querySelector('#smart-search').value.trim(),
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
function comparableUrl(value) { try { const url = new URL(value); url.hash = ''; return `${url.origin}${url.pathname.replace(/\/$/, '')}`.toLowerCase(); } catch { return ''; } }
function list(selector) { return document.querySelector(selector).value.split(/[,\n]/).map((value) => value.trim()).filter(Boolean); }
function value(selector) { return document.querySelector(selector).value.trim(); }
function termChip(value) { return `<span>${escape(value)}</span>`; }
function providerName(value) { return ({openrouter:'OpenRouter', openai:'OpenAI', anthropic:'Anthropic'})[value] || 'AI provider'; }
function escape(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }

loadState().finally(() => {
  pollBrowserVerification();
  setInterval(pollBrowserVerification, 2_000);
});
