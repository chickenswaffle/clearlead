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
let current = null;
let appState = null;
let resumeReady = false;
let refreshTimer = null;
let countdownTimer = null;
let searching = false;
let verifying = false;
let lastBrowserCaptureId = '';
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
  document.querySelector('#verify-panel').scrollIntoView({behavior: 'smooth'});
  document.querySelector('#job-url').focus();
});
document.querySelector('#smart-search').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') searchJobs();
});
document.querySelector('#save-provider').addEventListener('click', saveProvider);
document.querySelector('#test-provider').addEventListener('click', testProvider);
document.querySelector('#remove-provider').addEventListener('click', removeProvider);
document.querySelector('#ai-provider').addEventListener('change', updateModelPlaceholder);
document.querySelector('#pair-extension').addEventListener('click', pairExtension);

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
    const [data, application] = await Promise.all([
      requestJson('/api/profile', {method: 'POST', body: JSON.stringify({
        targetRoles: list('#target-roles'),
        locations: list('#locations'),
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
    workAuthorization: value('#work-authorization'), needsSponsorship: value('#needs-sponsorship'), relocation: value('#relocation'),
  };
}

function showApplicationProfile(profile = {}, state = {}) {
  const fields = {'#full-name':'fullName','#application-email':'email','#application-phone':'phone','#application-location':'location','#application-city':'city','#application-state':'state','#application-postal':'postalCode','#application-country':'country','#linkedin-url':'linkedinUrl','#github-url':'githubUrl','#portfolio-url':'portfolioUrl','#desired-salary':'desiredSalary','#work-authorization':'workAuthorization','#needs-sponsorship':'needsSponsorship','#relocation':'relocation'};
  const choiceFields = new Set(['#work-authorization', '#needs-sponsorship', '#relocation']);
  for (const [selector, key] of Object.entries(fields)) document.querySelector(selector).value = profile[key] || (choiceFields.has(selector) ? 'unknown' : '');
  if (state.message && !state.ready) readiness.textContent = `${readiness.textContent} ${state.message}`.trim();
}

async function pairExtension() {
  const button = document.querySelector('#pair-extension');
  button.disabled = true;
  try {
    const pairing = await requestJson('/api/extension/pair', {method: 'POST', body: '{}'});
    document.querySelector('#extension-status').className = 'readiness ready';
    document.querySelector('#extension-status').textContent = 'Pairing token ready.';
    document.querySelector('#pairing-output').innerHTML = `<p>1. Open <code>chrome://extensions</code>, enable Developer mode, and load this unpacked folder:</p><code>${escape(pairing.extensionPath)}</code><p>2. Paste this pairing token into the ClearLead extension:</p><div class="token-row"><code id="pairing-token">${escape(pairing.token)}</code><button class="button ghost" id="copy-pairing">Copy token</button></div><p class="quiet">Creating another token invalidates this one.</p>`;
    document.querySelector('#copy-pairing').addEventListener('click', async () => { await navigator.clipboard.writeText(pairing.token); document.querySelector('#copy-pairing').textContent = 'Copied'; });
  } catch (error) { document.querySelector('#pairing-output').textContent = error.message; }
  finally { button.disabled = false; }
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
    : `${data.total} ranked roles · ${data.matchedCount || data.total} eligible in the deduplicated pool · ${data.rejectedCount || 0} rejected by hard requirements · ${data.checkedCount || 0} checked · ${data.verifiedCount || 0} verified live`;
  sourceHealth.innerHTML = data.sources.map((source) => `<span class="source-chip ${source.ok ? 'ok' : 'fail'}">${escape(source.name)} · ${source.ok ? `${source.count} published${source.cached ? ' · cached' : ''}` : escape(source.error)}</span>`).join('');
  searchResults.innerHTML = data.outage
    ? '<div class="empty-state"><strong>All job sources are unavailable.</strong><p>Nothing was called published or live. Retry later or inspect source errors above.</p><button class="button ghost" id="retry-outage">Retry sources</button></div>'
    : data.jobs.length
      ? data.jobs.map(jobCard).join('')
      : '<div class="empty-state"><strong>No matching postings in the current pool.</strong><p>Try fewer title words, remove the location filter, or restore more source boards.</p></div>';
  const plan = document.querySelector('#search-plan');
  plan.innerHTML = data.plan ? `<strong>${escape(data.plan.mode === 'ai' ? 'AI-expanded search' : 'Built-in expanded search')} · ${escape(data.plan.explanation)}</strong>${(data.plan.titles || []).slice(0, 10).map((item) => `<span>${escape(item)}</span>`).join('')}${(data.plan.locations || []).slice(0, 8).map((item) => `<span>near ${escape(item)}</span>`).join('')}${data.plan.note ? `<span>${escape(data.plan.note)}</span>` : ''}` : '';
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
    ? `<button class="button ghost" data-resume="${escape(check.verificationId)}">Make custom resume</button><button class="button ghost" data-autofill="${escape(check.verificationId)}">Prepare application</button>`
    : status === 'closed'
      ? '<button class="button ghost" disabled>Closed</button>'
      : `<button class="button primary" data-verify-url="${escape(job.applyUrl || job.url)}" ${metadata(job)}>Verify ${status === 'unverified' ? 'role' : 'again'}</button>`;
  const skills = job.match?.matchedSkills?.length ? job.match.matchedSkills.join(', ') : job.match?.matchedKeywords?.slice(0, 5).join(', ');
  const breakdown = job.match?.breakdown;
  const sourceUrl = safeHttpUrl(job.url) ? job.url : '#verify-panel';
  const verificationEvidence = check ? verificationEvidenceMarkup({...check, source: check.source || job.source}, {allowSave: status === 'live'}) : '';
  return `<article class="job-card ${job.isNew ? 'new' : ''} ${status === 'live' ? 'verified' : ''} ${status === 'closed' ? 'closed' : ''}" data-job-url="${escape(job.applyUrl || job.url)}">
    <div class="job-top"><span class="company">${escape(job.company)} · ${escape(job.source)}</span><div class="badges">${job.isNew ? '<span class="badge new">new</span>' : ''}<span class="badge verification-badge ${escape(status)}">${escape(badge)}</span></div></div>
    <h3>${escape(job.title)}</h3>
    <div class="job-meta">${escape(job.location)}<br>published ${escape(age)}</div>
    <div class="score-row"><strong>${score}</strong><span>resume match</span>${breakdown ? `<i>title ${breakdown.title} · evidence ${breakdown.resume} · location ${breakdown.location} · sector ${breakdown.sector ?? '—'} · fresh ${breakdown.freshness}</i>` : ''}</div>
    <div class="matchbar" aria-label="${score}% resume match"><i style="width:${Math.max(3, Math.min(score, 100))}%"></i></div>
    <div class="match-copy">${skills ? `matched: ${escape(skills)}` : 'No explicit skill overlap found'}</div>
    <details class="job-description"><summary>Read job description</summary><p>${escape(job.description || 'The source did not provide a description. Open the posting to review it.')}</p></details>
    ${verificationEvidence}
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
    if (check.status === 'blocked') result.insertAdjacentHTML('beforeend', '<div class="browser-handoff"><strong>CAPTCHA handoff</strong><p>Open the source, complete the challenge yourself, wait for the job posting to render, then click <em>Verify current job page</em> in the paired ClearLead extension.</p><button class="button ghost" id="show-extension-setup">Set up browser verification</button></div>');
    result.insertAdjacentHTML('beforeend', `<p class="quiet">Nothing was saved. Choose what happens next.</p>${actionMarkup(check.finalUrl || check.url)}`);
    wireOutcomeActions(check.finalUrl || check.url);
    document.querySelector('#show-extension-setup')?.addEventListener('click', () => document.querySelector('#extension-setup').scrollIntoView({behavior: 'smooth', block: 'center'}));
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
  </section>`;

  const studio = tailorOutput.querySelector('.resume-studio');
  const input = studio.querySelector('.studio-filename input');
  const pdfLink = studio.querySelector('[data-studio-pdf]');
  const markdownLink = studio.querySelector('[data-studio-markdown]');
  const syncNames = () => {
    const name = resumeFileStem(input.value);
    pdfLink.href = namedDownloadUrl(draft.pdfUrl, name);
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
    const downloads = `<a class="button primary" href="${escape(kit.pdfUrl)}">Download AI resume PDF</a>` + Object.entries(kit.downloads).map(([name, url]) => `<a class="button ghost" href="${escape(url)}">${escape(labels[name] || name)}</a>`).join('');
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
    const resumeHandoff = pack.resume ? `<div class="application-resume"><div><strong>Selected resume</strong><span>${escape(pack.resume.filename)}</span></div><a class="button ghost" href="${escape(pack.resume.pdfUrl)}">Download selected PDF</a></div>` : '<p class="quiet">No tailored resume is attached to this handoff. Choose and upload a resume on the employer page.</p>';
    autofillOutput.className = 'tailor-output active';
    autofillOutput.innerHTML = `<div class="tailor-head"><div><p class="eyebrow">application handoff ready</p><h3>${escape(pack.job.company)} · ${escape(pack.job.title)}</h3></div><a class="button primary" href="${escape(pack.job.applicationUrl)}" target="_blank" rel="noreferrer">Open verified application ↗</a></div>${resumeHandoff}<p class="quiet">Download the selected PDF, open that exact verified page, and upload it when the employer asks. Then click <strong>Fill safe fields</strong> in the paired ClearLead extension. Review every answer yourself; Submit is never clicked.</p>`;
    autofillOutput.scrollIntoView({behavior: 'smooth', block: 'center'});
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
      return `<article class="lead"><i class="lead-status"></i><div>${link}<p class="why">${lead.company ? `${escape(lead.company)} · ` : ''}${escape(lead.reason)}</p>${verificationEvidenceMarkup(lead, {queue: true})}<div class="lead-actions">${reverify}</div></div><time>${relativeTime(lead.savedAt)}</time></article>`;
    }).join('')
    : '<div class="empty-state"><strong>Your queue is clear.</strong><p>Search a role, verify it live, then add it here for review.</p></div>';
  wireJobActions(leads);
}

async function loadState({autoSearch = true} = {}) {
  try {
    const data = await requestJson('/api/leads');
    appState = data;
    showRuntimeReadiness(data.runtime);
    showResume(data.resume);
    showProfile(data.profile, data.readiness);
    showApplicationProfile(data.applicationProfile, data.applicationReadiness);
    document.querySelector('#extension-status').className = `readiness ${data.extensionPaired ? 'ready' : 'not-ready'}`;
    document.querySelector('#extension-status').textContent = data.extensionPaired ? 'Extension pairing exists.' : 'Extension not paired.';
    showSearchConfig(data.searchConfig);
    renderQueue(data.leads);
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
function list(selector) { return document.querySelector(selector).value.split(/[,\n]/).map((value) => value.trim()).filter(Boolean); }
function value(selector) { return document.querySelector(selector).value.trim(); }
function termChip(value) { return `<span>${escape(value)}</span>`; }
function providerName(value) { return ({openrouter:'OpenRouter', openai:'OpenAI', anthropic:'Anthropic'})[value] || 'AI provider'; }
function escape(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }

loadState().finally(() => {
  pollBrowserVerification();
  setInterval(pollBrowserVerification, 2_000);
});
