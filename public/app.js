const result = document.querySelector('#result');
const leads = document.querySelector('#leads');
let current = null;

document.querySelector('#verify').addEventListener('click', async () => {
  const url = document.querySelector('#job-url').value.trim();
  result.innerHTML = '<p class="quiet">Checking the source…</p>';
  const response = await fetch('/api/verify', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url})});
  current = await response.json();
  renderResult(current);
});

function renderResult(check) {
  result.className = `result ${check.status}`;
  result.innerHTML = `<div class="status">${check.status}</div><strong>${check.reason}</strong><p class="why">Checked ${new Date(check.checkedAt).toLocaleString()}${check.httpStatus ? ` · HTTP ${check.httpStatus}` : ''}<br>${escape(check.finalUrl || check.url || '')}</p>`;
  if (check.status === 'live') {
    const save = document.createElement('button'); save.textContent = 'Save this live lead';
    save.onclick = async () => { const response = await fetch('/api/leads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(current)}); const saved = await response.json(); result.insertAdjacentHTML('beforeend', `<p class="quiet">${saved.saved ? 'Saved.' : saved.reason}</p>`); load(); };
    result.append(save);
  } else if (check.status === 'blocked') result.insertAdjacentHTML('beforeend','<p class="quiet">Next: open the source in your browser and complete its normal access check. Nothing was saved.</p>');
  else if (check.status === 'inconclusive') result.insertAdjacentHTML('beforeend','<p class="quiet">Next: retry later, open the source in your browser, or discard it. Nothing was saved.</p>');
}
async function load(){const response=await fetch('/api/leads');const data=await response.json();leads.innerHTML=data.leads.length?data.leads.map(lead=>`<article class="lead live"><div class="status">Live</div><a href="${escape(lead.finalUrl)}" target="_blank" rel="noreferrer">${escape(lead.finalUrl)}</a><p class="why">${escape(lead.reason)} · ${new Date(lead.checkedAt).toLocaleString()}</p></article>`).join(''):'<p class="quiet">No confirmed leads yet.</p>'}
function escape(value){return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))}
load();
