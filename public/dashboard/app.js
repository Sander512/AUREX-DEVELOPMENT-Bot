// public/dashboard/app.js
// Auth flow: "Inloggen met Discord" (server-side OAuth, /auth/discord) sets
// an httpOnly session cookie — the browser never sees an API key. This
// file just calls /auth/me to find out who's logged in and which servers
// they can manage, lets them pick one, then drives the existing
// /tickets/* API using that cookie (credentials: 'include').

const state = {
  guildId: '',
  guildName: '',
  guilds: [],
  types: [],
};

const $ = (id) => document.getElementById(id);

const SELECTED_GUILD_KEY = 'ticketDashboardSelectedGuild';

function loadSelectedGuild() {
  return sessionStorage.getItem(SELECTED_GUILD_KEY) || '';
}

function saveSelectedGuild(guildId) {
  sessionStorage.setItem(SELECTED_GUILD_KEY, guildId);
}

function clearSelectedGuild() {
  sessionStorage.removeItem(SELECTED_GUILD_KEY);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function guildIconUrl(guild) {
  if (!guild.icon) return null;
  return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64`;
}

function showScreen(name) {
  $('loginScreen').classList.toggle('hidden', name !== 'login');
  $('pickerScreen').classList.toggle('hidden', name !== 'picker');
  $('app').classList.toggle('hidden', name !== 'app');
}

// ---- Login screen ----
const LOGIN_ERROR_MESSAGES = {
  invalid_state: 'Inloggen mislukt (verlopen of ongeldige sessie). Probeer het opnieuw.',
  token_exchange_failed: 'Discord heeft de login geweigerd. Probeer het opnieuw.',
  rate_limited: 'Discord is momenteel tijdelijk overbelast voor deze server. Wacht een paar minuten en probeer het opnieuw.',
  access_denied: 'Je hebt het inloggen geannuleerd.',
};

function showLoginErrorFromUrl() {
  const params = new URLSearchParams(location.search);
  const err = params.get('login_error');
  if (err) {
    $('loginError').textContent = LOGIN_ERROR_MESSAGES[err] || `Inloggen mislukt: ${err}`;
    history.replaceState(null, '', location.pathname);
  }
}

// ---- Server picker ----
function renderPicker() {
  const list = $('pickerList');

  if (state.guilds.length === 0) {
    list.innerHTML =
      '<div class="empty-state">Geen servers gevonden waar je beheerrechten hebt én de bot in zit.<br />Zorg dat de bot is uitgenodigd op je server en je daar "Server beheren" of Administrator rechten hebt.</div>';
    return;
  }

  list.innerHTML = '';
  state.guilds.forEach((g) => {
    const row = document.createElement('button');
    row.className = 'picker-row';
    const iconUrl = guildIconUrl(g);
    row.innerHTML = `
      ${iconUrl
        ? `<img class="picker-icon" src="${iconUrl}" alt="" />`
        : `<div class="picker-icon picker-icon-fallback">${escapeHtml((g.name || '?').charAt(0).toUpperCase())}</div>`
      }
      <div class="picker-name">${escapeHtml(g.name)}</div>
      <span class="picker-arrow">→</span>
    `;
    row.addEventListener('click', () => selectGuild(g));
    list.appendChild(row);
  });
}

function selectGuild(guild) {
  state.guildId = guild.id;
  state.guildName = guild.name;
  saveSelectedGuild(guild.id);
  boot();
}

$('pickerLogoutBtn').addEventListener('click', logout);
$('switchServerBtn').addEventListener('click', () => {
  clearSelectedGuild();
  showScreen('picker');
});

async function logout() {
  try {
    await api('POST', '/auth/logout');
  } catch {
    // ignore — clearing local state below is enough either way
  }
  clearSelectedGuild();
  state.guildId = '';
  state.guilds = [];
  showScreen('login');
}

$('logoutBtn').addEventListener('click', logout);

// ---- Tabs ----
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
    btn.classList.add('active');
    $(`tab-${btn.dataset.tab}`).classList.remove('hidden');

    const titles = {
      settings: ['Paneel instellingen', 'Pas het uiterlijk en gedrag van je ticket panel volledig aan.'],
      types: ['Ticket types', 'Beheer de opties die gebruikers kunnen kiezen in het panel.'],
      tickets: ['Open tickets', 'Overzicht van alle momenteel open of geclaimde tickets.'],
      welcome: ['Welkomstbericht', 'Stel in wat er gebeurt zodra iemand de server joint.'],
      verify: ['Verificatie', 'Stel het verificatie-paneel en de bijbehorende rol in.'],
      rules: ['Regels', 'Stel de regels-embed in die met /rules-send geplaatst wordt.'],
      shop: ['Webshop', 'Beheer producten, bekijk aankopen en stuur update-DM\'s naar kopers.'],
    };
    $('pageTitle').textContent = titles[btn.dataset.tab][0];
    $('pageSubtitle').textContent = titles[btn.dataset.tab][1];

    if (btn.dataset.tab === 'tickets') loadTickets();
    if (btn.dataset.tab === 'welcome') loadWelcomeConfig();
    if (btn.dataset.tab === 'verify') loadVerifyConfig();
    if (btn.dataset.tab === 'rules') loadRulesConfig();
    if (btn.dataset.tab === 'shop') loadShop();
  });
});

// ---- Settings tab ----
function fillSettingsForm(config) {
  $('cfg_panelTitle').value = config.panelTitle || '';
  $('cfg_panelDescription').value = config.panelDescription || '';
  $('cfg_panelColor').value = config.panelColor || '1e3a8a';
  $('cfg_panelColorPicker').value = `#${config.panelColor || '1e3a8a'}`;
  $('cfg_panelImage').value = config.panelImage || '';
  $('cfg_panelThumbnail').value = config.panelThumbnail || '';
  $('cfg_panelFooter').value = config.panelFooter || '';
  $('cfg_categoryId').value = config.categoryId || '';
  $('cfg_logChannelId').value = config.logChannelId || '';
  $('cfg_supportRoleId').value = config.supportRoleId || '';
  $('cfg_nameFormat').value = config.nameFormat || '';
  $('cfg_pingSupportRole').checked = !!config.pingSupportRole;
  $('cfg_requireCloseReason').checked = !!config.requireCloseReason;
  $('cfg_maxOpenPerUser').value = config.maxOpenPerUser || 1;
  $('cfg_welcomeMessage').value = config.welcomeMessage || '';
  $('cfg_showTicketInfo').checked = config.showTicketInfo !== false;
  updatePreview();
}

function updatePreview() {
  $('previewBar').style.background = `#${($('cfg_panelColor').value || '1e3a8a').replace('#', '')}`;
  $('previewTitle').textContent = $('cfg_panelTitle').value || 'Support Tickets';
  $('previewDesc').textContent = $('cfg_panelDescription').value || '';
  $('previewFooter').textContent = $('cfg_panelFooter').value || '';

  const thumb = $('cfg_panelThumbnail').value;
  $('previewThumb').src = thumb;
  $('previewThumb').classList.toggle('hidden', !thumb);

  const image = $('cfg_panelImage').value;
  $('previewImage').src = image;
  $('previewImage').classList.toggle('hidden', !image);
}

['cfg_panelTitle', 'cfg_panelDescription', 'cfg_panelFooter', 'cfg_panelImage', 'cfg_panelThumbnail'].forEach((id) =>
  $(id).addEventListener('input', updatePreview)
);

$('cfg_panelColorPicker').addEventListener('input', () => {
  $('cfg_panelColor').value = $('cfg_panelColorPicker').value.replace('#', '');
  updatePreview();
});
$('cfg_panelColor').addEventListener('input', () => {
  const clean = $('cfg_panelColor').value.replace('#', '');
  if (/^[0-9a-fA-F]{6}$/.test(clean)) $('cfg_panelColorPicker').value = `#${clean}`;
  updatePreview();
});

$('saveSettingsBtn').addEventListener('click', async () => {
  const btn = $('saveSettingsBtn');
  const status = $('saveStatus');
  btn.disabled = true;
  status.style.color = 'var(--success)';
  status.textContent = 'Opslaan...';

  const fields = {
    panelTitle: $('cfg_panelTitle').value,
    panelDescription: $('cfg_panelDescription').value,
    panelColor: $('cfg_panelColor').value.replace('#', '') || '1e3a8a',
    panelImage: $('cfg_panelImage').value || null,
    panelThumbnail: $('cfg_panelThumbnail').value || null,
    panelFooter: $('cfg_panelFooter').value || null,
    categoryId: $('cfg_categoryId').value || null,
    logChannelId: $('cfg_logChannelId').value || null,
    supportRoleId: $('cfg_supportRoleId').value || null,
    nameFormat: $('cfg_nameFormat').value || 'ticket-{number}',
    welcomeMessage: $('cfg_welcomeMessage').value,
    pingSupportRole: $('cfg_pingSupportRole').checked,
    requireCloseReason: $('cfg_requireCloseReason').checked,
    maxOpenPerUser: parseInt($('cfg_maxOpenPerUser').value, 10) || 1,
    showTicketInfo: $('cfg_showTicketInfo').checked,
  };

  try {
    const { config } = await api('POST', '/tickets/config', { guildId: state.guildId, ...fields });
    fillSettingsForm(config);
    status.textContent = '✅ Opgeslagen';
  } catch (err) {
    status.style.color = 'var(--danger)';
    status.textContent = `❌ ${err.message}`;
  } finally {
    btn.disabled = false;
    setTimeout(() => (status.textContent = ''), 4000);
  }
});

// ---- Types tab ----
const TYPE_FORM_FIELDS = [
  'type_label',
  'type_emoji',
  'type_key',
  'type_description',
  'type_categoryId',
  'type_supportRoleId',
  'type_nameFormat',
  'type_welcomeMessage',
  'type_maxOpenOverride',
];

state.editingTypeKey = null;

function badge(text, tone) {
  return `<span class="type-flag type-flag-${tone || 'muted'}">${escapeHtml(text)}</span>`;
}

function renderTypes() {
  $('typeCount').textContent = `${state.types.length}/25`;
  const list = $('typesList');

  if (state.types.length === 0) {
    list.innerHTML = '<div class="empty-state">Nog geen ticket types toegevoegd.</div>';
    return;
  }

  list.innerHTML = '';
  state.types.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'type-row';

    const flags = [];
    if (t.claimEnabled === false) flags.push(badge('Claim uit', 'off'));
    if (t.closeEnabled === false) flags.push(badge('Sluiten uit', 'off'));
    if (t.askDescription !== false) flags.push(badge('Vraagt beschrijving', 'on'));
    if (t.maxOpenOverride) flags.push(badge(`Max ${t.maxOpenOverride}`, 'on'));

    row.innerHTML = `
      <div class="type-row-info">
        <span class="type-emoji">${t.emoji || '🎫'}</span>
        <div>
          <div class="type-label">${escapeHtml(t.label)} <span class="type-key">(${escapeHtml(t.key)})</span></div>
          ${t.description ? `<div class="type-desc">${escapeHtml(t.description)}</div>` : ''}
          ${flags.length ? `<div class="type-flags">${flags.join('')}</div>` : ''}
        </div>
      </div>
      <div class="type-row-actions">
        <button class="btn btn-ghost btn-small" data-action="edit" data-key="${escapeHtml(t.key)}">Bewerken</button>
        <button class="btn btn-danger btn-small" data-action="delete" data-key="${escapeHtml(t.key)}">Verwijderen</button>
      </div>
    `;
    row.querySelector('[data-action="edit"]').addEventListener('click', () => startEditType(t));
    row.querySelector('[data-action="delete"]').addEventListener('click', () => removeType(t.key));
    list.appendChild(row);
  });
}

async function loadTypes() {
  const { types } = await api('GET', `/tickets/types/${state.guildId}`);
  state.types = types;
  renderTypes();
}

async function removeType(key) {
  if (!confirm(`Ticket type "${key}" verwijderen?`)) return;
  try {
    await api('DELETE', `/tickets/types/${state.guildId}/${encodeURIComponent(key)}`);
    if (state.editingTypeKey === key) resetTypeForm();
    await loadTypes();
  } catch (err) {
    alert(`Verwijderen mislukt: ${err.message}`);
  }
}

function startEditType(t) {
  state.editingTypeKey = t.key;
  $('type_label').value = t.label || '';
  $('type_emoji').value = t.emoji || '';
  $('type_key').value = t.key || '';
  $('type_key').disabled = true;
  $('type_description').value = t.description || '';
  $('type_categoryId').value = t.categoryId || '';
  $('type_supportRoleId').value = t.supportRoleId || '';
  $('type_nameFormat').value = t.nameFormat || '';
  $('type_welcomeMessage').value = t.welcomeMessage || '';
  $('type_maxOpenOverride').value = t.maxOpenOverride || '';
  $('type_claimEnabled').checked = t.claimEnabled !== false;
  $('type_closeEnabled').checked = t.closeEnabled !== false;
  $('type_askDescription').checked = t.askDescription !== false;

  $('typeFormTitle').textContent = `Type bewerken — ${t.label}`;
  $('addTypeBtn').textContent = '💾 Wijzigingen opslaan';
  $('cancelEditTypeBtn').classList.remove('hidden');
  document.querySelector('[data-tab="types"]').scrollIntoView?.();
}

function resetTypeForm() {
  state.editingTypeKey = null;
  TYPE_FORM_FIELDS.forEach((id) => ($(id).value = ''));
  $('type_key').disabled = false;
  $('type_claimEnabled').checked = true;
  $('type_closeEnabled').checked = true;
  $('type_askDescription').checked = true;
  $('typeFormTitle').textContent = 'Nieuw ticket type';
  $('addTypeBtn').textContent = '➕ Type toevoegen';
  $('cancelEditTypeBtn').classList.add('hidden');
}

$('cancelEditTypeBtn').addEventListener('click', resetTypeForm);

$('addTypeBtn').addEventListener('click', async () => {
  const btn = $('addTypeBtn');
  const status = $('addTypeStatus');
  const label = $('type_label').value.trim();
  const isEditing = !!state.editingTypeKey;

  if (!label) {
    status.style.color = 'var(--danger)';
    status.textContent = '❌ Label is verplicht';
    return;
  }

  btn.disabled = true;
  status.style.color = 'var(--success)';
  status.textContent = isEditing ? 'Opslaan...' : 'Toevoegen...';

  const maxOpenRaw = $('type_maxOpenOverride').value.trim();

  const sharedFields = {
    label,
    emoji: $('type_emoji').value.trim() || null,
    description: $('type_description').value.trim() || null,
    categoryId: $('type_categoryId').value.trim() || null,
    supportRoleId: $('type_supportRoleId').value.trim() || null,
    nameFormat: $('type_nameFormat').value.trim() || null,
    welcomeMessage: $('type_welcomeMessage').value.trim() || null,
    claimEnabled: $('type_claimEnabled').checked,
    closeEnabled: $('type_closeEnabled').checked,
    askDescription: $('type_askDescription').checked,
    maxOpenOverride: maxOpenRaw ? parseInt(maxOpenRaw, 10) : null,
  };

  try {
    if (isEditing) {
      await api('PATCH', `/tickets/types/${state.guildId}/${encodeURIComponent(state.editingTypeKey)}`, sharedFields);
      status.textContent = '✅ Opgeslagen';
    } else {
      await api('POST', '/tickets/types', {
        guildId: state.guildId,
        key: $('type_key').value.trim() || undefined,
        ...sharedFields,
      });
      status.textContent = '✅ Toegevoegd';
    }
    resetTypeForm();
    await loadTypes();
  } catch (err) {
    status.style.color = 'var(--danger)';
    status.textContent = `❌ ${err.message}`;
  } finally {
    btn.disabled = false;
    setTimeout(() => (status.textContent = ''), 4000);
  }
});

// ---- Tickets tab ----
async function loadTickets() {
  const list = $('ticketsList');
  list.innerHTML = '<div class="empty-state">Laden...</div>';

  try {
    const { tickets } = await api('GET', `/tickets/list/${state.guildId}`);
    const open = tickets.filter((t) => t.status !== 'closed');

    if (open.length === 0) {
      list.innerHTML = '<div class="empty-state">Geen open tickets.</div>';
      return;
    }

    list.innerHTML = '';
    open.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'ticket-row';
      row.innerHTML = `
        <div>#${String(t.ticketNumber).padStart(4, '0')} — ${escapeHtml(t.typeLabel || 'Onbekend type')}</div>
        <span class="ticket-badge ${t.claimedBy ? 'claimed' : ''}">${t.claimedBy ? 'Geclaimd' : 'Open'}</span>
      `;
      list.appendChild(row);
    });
  } catch (err) {
    list.innerHTML = `<div class="empty-state">Fout bij laden: ${escapeHtml(err.message)}</div>`;
  }
}

$('refreshTicketsBtn').addEventListener('click', loadTickets);

// ---- Welcome message tab ----
function fillWelcomeForm(config) {
  $('wc_enabled').checked = !!config.enabled;
  $('wc_channelId').value = config.channelId || '';
  $('wc_content').value = config.content || '';
  $('wc_embedEnabled').checked = !!config.embedEnabled;
  $('wc_embedTitle').value = config.embedTitle || '';
  $('wc_embedDescription').value = config.embedDescription || '';
  $('wc_embedColor').value = config.embedColor || '10b981';
  $('wc_embedColorPicker').value = `#${config.embedColor || '10b981'}`;
  $('wc_embedImage').value = config.embedImage || '';
  $('wc_embedFooter').value = config.embedFooter || '';
  $('wc_useAvatarThumbnail').checked = !!config.useAvatarThumbnail;
  $('wc_autoRoleId').value = config.autoRoleId || '';
  $('wc_dmEnabled').checked = !!config.dmEnabled;
  $('wc_dmMessage').value = config.dmMessage || '';
  updateWelcomePreview();
}

const WELCOME_PREVIEW_MEMBER = { user: 'NieuwLid', server: state.guildName || 'de server', membercount: '128' };

function fillWelcomePreviewPlaceholders(text) {
  return String(text || '')
    .replaceAll('{user}', `@${WELCOME_PREVIEW_MEMBER.user}`)
    .replaceAll('{username}', WELCOME_PREVIEW_MEMBER.user)
    .replaceAll('{server}', state.guildName || WELCOME_PREVIEW_MEMBER.server)
    .replaceAll('{membercount}', WELCOME_PREVIEW_MEMBER.membercount);
}

function updateWelcomePreview() {
  const enabled = $('wc_embedEnabled').checked;
  $('wcPreviewEmbed').classList.toggle('hidden', !enabled);
  if (!enabled) return;

  $('wcPreviewBar').style.background = `#${($('wc_embedColor').value || '10b981').replace('#', '')}`;
  $('wcPreviewTitle').textContent = fillWelcomePreviewPlaceholders($('wc_embedTitle').value) || 'Welkom op de server!';
  $('wcPreviewDesc').textContent = fillWelcomePreviewPlaceholders($('wc_embedDescription').value);
  $('wcPreviewFooter').textContent = $('wc_embedFooter').value || '';

  const thumb = $('wc_useAvatarThumbnail').checked;
  $('wcPreviewThumb').src = thumb ? 'https://cdn.discordapp.com/embed/avatars/1.png' : '';
  $('wcPreviewThumb').classList.toggle('hidden', !thumb);

  const image = $('wc_embedImage').value;
  $('wcPreviewImage').src = image;
  $('wcPreviewImage').classList.toggle('hidden', !image);
}

[
  'wc_embedTitle',
  'wc_embedDescription',
  'wc_embedFooter',
  'wc_embedImage',
  'wc_embedEnabled',
  'wc_useAvatarThumbnail',
].forEach((id) => $(id).addEventListener('input', updateWelcomePreview));

$('wc_embedColorPicker').addEventListener('input', () => {
  $('wc_embedColor').value = $('wc_embedColorPicker').value.replace('#', '');
  updateWelcomePreview();
});
$('wc_embedColor').addEventListener('input', () => {
  const clean = $('wc_embedColor').value.replace('#', '');
  if (/^[0-9a-fA-F]{6}$/.test(clean)) $('wc_embedColorPicker').value = `#${clean}`;
  updateWelcomePreview();
});

async function loadWelcomeConfig() {
  try {
    const { config } = await api('GET', `/welcome/config/${state.guildId}`);
    fillWelcomeForm(config);
  } catch (err) {
    $('saveWelcomeStatus').style.color = 'var(--danger)';
    $('saveWelcomeStatus').textContent = `❌ Laden mislukt: ${err.message}`;
  }
}

$('saveWelcomeBtn').addEventListener('click', async () => {
  const btn = $('saveWelcomeBtn');
  const status = $('saveWelcomeStatus');
  btn.disabled = true;
  status.style.color = 'var(--success)';
  status.textContent = 'Opslaan...';

  const fields = {
    enabled: $('wc_enabled').checked,
    channelId: $('wc_channelId').value || null,
    content: $('wc_content').value,
    embedEnabled: $('wc_embedEnabled').checked,
    embedTitle: $('wc_embedTitle').value,
    embedDescription: $('wc_embedDescription').value,
    embedColor: $('wc_embedColor').value.replace('#', '') || '10b981',
    embedImage: $('wc_embedImage').value || null,
    embedFooter: $('wc_embedFooter').value || null,
    useAvatarThumbnail: $('wc_useAvatarThumbnail').checked,
    autoRoleId: $('wc_autoRoleId').value || null,
    dmEnabled: $('wc_dmEnabled').checked,
    dmMessage: $('wc_dmMessage').value,
  };

  try {
    const { config } = await api('POST', '/welcome/config', { guildId: state.guildId, ...fields });
    fillWelcomeForm(config);
    status.textContent = '✅ Opgeslagen';
  } catch (err) {
    status.style.color = 'var(--danger)';
    status.textContent = `❌ ${err.message}`;
  } finally {
    btn.disabled = false;
    setTimeout(() => (status.textContent = ''), 4000);
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// ---- Verify tab ----
function fillVerifyForm(config) {
  $('vf_roleId').value = (config.roleIds || []).join(', ');
  $('vf_panelTitle').value = config.panelTitle || '';
  $('vf_panelDescription').value = config.panelDescription || '';
  $('vf_panelColor').value = config.panelColor || '5865f2';
  $('vf_panelColorPicker').value = `#${config.panelColor || '5865f2'}`;
  $('vf_panelImage').value = config.panelImage || '';
  $('vf_panelFooter').value = config.panelFooter || '';
  $('vf_buttonLabel').value = config.buttonLabel || 'Verifiëren';
  $('vf_logChannelId').value = config.logChannelId || '';
  updateVerifyPreview();
}

function updateVerifyPreview() {
  $('vfPreviewBar').style.background = `#${($('vf_panelColor').value || '5865f2').replace('#', '')}`;
  $('vfPreviewTitle').textContent = $('vf_panelTitle').value || '🔐 Verifieer jezelf';
  $('vfPreviewDesc').textContent = $('vf_panelDescription').value || '';
  $('vfPreviewFooter').textContent = $('vf_panelFooter').value || '';
  const image = $('vf_panelImage').value;
  $('vfPreviewImage').src = image;
  $('vfPreviewImage').classList.toggle('hidden', !image);
}

['vf_panelTitle', 'vf_panelDescription', 'vf_panelImage', 'vf_panelFooter'].forEach((id) =>
  $(id).addEventListener('input', updateVerifyPreview)
);
$('vf_panelColorPicker').addEventListener('input', () => {
  $('vf_panelColor').value = $('vf_panelColorPicker').value.replace('#', '');
  updateVerifyPreview();
});
$('vf_panelColor').addEventListener('input', () => {
  const clean = $('vf_panelColor').value.replace('#', '');
  if (/^[0-9a-fA-F]{6}$/.test(clean)) $('vf_panelColorPicker').value = `#${clean}`;
  updateVerifyPreview();
});

async function loadVerifyConfig() {
  try {
    const { config } = await api('GET', `/verify/config/${state.guildId}`);
    fillVerifyForm(config);
  } catch (err) {
    $('saveVerifyStatus').style.color = 'var(--danger)';
    $('saveVerifyStatus').textContent = `❌ Laden mislukt: ${err.message}`;
  }
}

$('saveVerifyBtn').addEventListener('click', async () => {
  const btn = $('saveVerifyBtn');
  const status = $('saveVerifyStatus');
  btn.disabled = true;
  status.style.color = 'var(--success)';
  status.textContent = 'Opslaan...';

  const roleIdsInput = $('vf_roleId').value || '';
  const roleIds = roleIdsInput
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  const fields = {
    roleIds: roleIds.length > 0 ? roleIds : null,
    panelTitle: $('vf_panelTitle').value,
    panelDescription: $('vf_panelDescription').value,
    panelColor: $('vf_panelColor').value.replace('#', '') || '5865f2',
    panelImage: $('vf_panelImage').value || null,
    panelFooter: $('vf_panelFooter').value || null,
    buttonLabel: $('vf_buttonLabel').value || 'Verifiëren',
    logChannelId: $('vf_logChannelId').value || null,
  };

  try {
    const { config } = await api('POST', '/verify/config', { guildId: state.guildId, ...fields });
    fillVerifyForm(config);
    status.textContent = '✅ Opgeslagen';
  } catch (err) {
    status.style.color = 'var(--danger)';
    status.textContent = `❌ ${err.message}`;
  } finally {
    btn.disabled = false;
    setTimeout(() => (status.textContent = ''), 4000);
  }
});

// ---- Rules tab ----
function fillRulesForm(config) {
  $('rl_channelId').value = config.channelId || '';
  $('rl_title').value = config.title || '';
  $('rl_description').value = config.description || '';
  $('rl_color').value = config.color || '5865f2';
  $('rl_colorPicker').value = `#${config.color || '5865f2'}`;
  $('rl_image').value = config.image || '';
  $('rl_footer').value = config.footer || '';
  updateRulesPreview();
}

function updateRulesPreview() {
  $('rlPreviewBar').style.background = `#${($('rl_color').value || '5865f2').replace('#', '')}`;
  $('rlPreviewTitle').textContent = $('rl_title').value || '📜 Server Regels';
  $('rlPreviewDesc').textContent = $('rl_description').value || '';
  $('rlPreviewFooter').textContent = $('rl_footer').value || '';
  const image = $('rl_image').value;
  $('rlPreviewImage').src = image;
  $('rlPreviewImage').classList.toggle('hidden', !image);
}

['rl_title', 'rl_description', 'rl_image', 'rl_footer'].forEach((id) => $(id).addEventListener('input', updateRulesPreview));
$('rl_colorPicker').addEventListener('input', () => {
  $('rl_color').value = $('rl_colorPicker').value.replace('#', '');
  updateRulesPreview();
});
$('rl_color').addEventListener('input', () => {
  const clean = $('rl_color').value.replace('#', '');
  if (/^[0-9a-fA-F]{6}$/.test(clean)) $('rl_colorPicker').value = `#${clean}`;
  updateRulesPreview();
});

async function loadRulesConfig() {
  try {
    const { config } = await api('GET', `/rules/config/${state.guildId}`);
    fillRulesForm(config);
  } catch (err) {
    $('saveRulesStatus').style.color = 'var(--danger)';
    $('saveRulesStatus').textContent = `❌ Laden mislukt: ${err.message}`;
  }
}

$('saveRulesBtn').addEventListener('click', async () => {
  const btn = $('saveRulesBtn');
  const status = $('saveRulesStatus');
  btn.disabled = true;
  status.style.color = 'var(--success)';
  status.textContent = 'Opslaan...';

  const fields = {
    channelId: $('rl_channelId').value || null,
    title: $('rl_title').value,
    description: $('rl_description').value,
    color: $('rl_color').value.replace('#', '') || '5865f2',
    image: $('rl_image').value || null,
    footer: $('rl_footer').value || null,
  };

  try {
    const { config } = await api('POST', '/rules/config', { guildId: state.guildId, ...fields });
    fillRulesForm(config);
    status.textContent = '✅ Opgeslagen';
  } catch (err) {
    status.style.color = 'var(--danger)';
    status.textContent = `❌ ${err.message}`;
  } finally {
    btn.disabled = false;
    setTimeout(() => (status.textContent = ''), 4000);
  }
});

// ---- Boot into the per-server settings dashboard ----
async function boot() {
  showScreen('app');
  $('guildPill').textContent = state.guildName || state.guildId;

  try {
    const { config, types } = await api('GET', `/tickets/config/${state.guildId}`);
    fillSettingsForm(config);
    state.types = types;
    renderTypes();
    $('statusPill').textContent = '● Verbonden';
    $('statusPill').style.background = '';
    $('statusPill').style.color = '';
  } catch (err) {
    $('statusPill').textContent = '● Fout';
    $('statusPill').style.background = 'rgba(239,68,68,0.12)';
    $('statusPill').style.color = '#fca5a5';
  }
}

// ---- Webshop tab ----
function formatPriceAdmin(cents, currency) {
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: (currency || 'eur').toUpperCase() }).format(
    (cents || 0) / 100
  );
}

function renderProductList(products) {
  const list = $('productList');

  if (products.length === 0) {
    list.innerHTML = `<p class="muted">Nog geen producten toegevoegd.</p>`;
    return;
  }

  list.innerHTML = products
    .map(
      (p) => `
    <div class="product-admin-row" data-id="${p.id}">
      <div class="product-admin-info">
        <div><strong>${escapeHtml(p.name)}</strong> ${p.active ? '' : '<span class="hint">(inactief)</span>'} ${
          p.version ? `<span class="product-version">v${escapeHtml(p.version)}</span>` : ''
        }</div>
        <div class="muted" style="font-size:13px;">${p.priceCents === 0 ? 'Gratis' : formatPriceAdmin(p.priceCents, p.currency)}${p.hasFile ? '' : ' · <span style="color:var(--danger)">⚠️ geen bestand</span>'}</div>
      </div>
      <div class="product-admin-actions">
        <button class="btn btn-ghost btn-small" data-action="toggle">${p.active ? 'Deactiveren' : 'Activeren'}</button>
        <button class="btn btn-ghost btn-small" data-action="notify">🔔 Stuur update</button>
        <button class="btn btn-danger btn-small" data-action="delete">Verwijderen</button>
      </div>
    </div>
  `
    )
    .join('');

  list.querySelectorAll('.product-admin-row').forEach((row) => {
    const id = row.dataset.id;
    const product = products.find((p) => p.id === id);

    row.querySelector('[data-action="toggle"]').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await api('POST', `/store/admin/products/${id}`, { guildId: state.guildId, active: !product.active });
        await loadShop();
      } catch (err) {
        alert(`Mislukt: ${err.message}`);
        e.target.disabled = false;
      }
    });

    row.querySelector('[data-action="delete"]').addEventListener('click', async (e) => {
      if (!confirm(`Product "${product.name}" verwijderen? Dit kan niet ongedaan gemaakt worden.`)) return;
      e.target.disabled = true;
      try {
        await api('DELETE', `/store/admin/products/${id}`, { guildId: state.guildId });
        await loadShop();
      } catch (err) {
        alert(`Mislukt: ${err.message}`);
        e.target.disabled = false;
      }
    });

    row.querySelector('[data-action="notify"]').addEventListener('click', async (e) => {
      if (!confirm(`Iedereen die "${product.name}" heeft gekocht krijgt nu een DM met de huidige versie/changelog. Doorgaan?`)) return;
      e.target.disabled = true;
      const original = e.target.textContent;
      e.target.textContent = 'Versturen...';
      try {
        const result = await api('POST', `/store/admin/products/${id}/notify`, { guildId: state.guildId });
        alert(result.message || `DM klaargezet voor ${result.queued} koper(s).`);
      } catch (err) {
        alert(`Mislukt: ${err.message}`);
      } finally {
        e.target.disabled = false;
        e.target.textContent = original;
      }
    });
  });
}

async function loadShop() {
  try {
    const { shopUrl } = await api('GET', '/store/config');
    $('shopLinkInput').value = shopUrl
      ? `${shopUrl}/?guild=${state.guildId}`
      : 'Zet SHOP_ORIGIN in je Render environment (URL van je Vercel-shop)';
  } catch {
    $('shopLinkInput').value = 'Kon shop-URL niet ophalen';
  }
  try {
    const { products } = await api('GET', `/store/admin/products/${state.guildId}`);
    renderProductList(products);
  } catch (err) {
    $('productList').innerHTML = `<div class="empty-state">Fout bij laden: ${escapeHtml(err.message)}</div>`;
  }
}

$('copyShopLinkBtn').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('shopLinkInput').value);
  const btn = $('copyShopLinkBtn');
  const original = btn.textContent;
  btn.textContent = '✅ Gekopieerd';
  setTimeout(() => (btn.textContent = original), 1500);
});

$('addProductBtn').addEventListener('click', async () => {
  const btn = $('addProductBtn');
  const status = $('addProductStatus');

  const name = $('sp_name').value.trim();
  const priceEuros = parseFloat($('sp_price').value);
  const file = $('sp_file').files[0];

  if (!name) return (status.textContent = '❌ Naam is verplicht'), (status.style.color = 'var(--danger)');
  if (Number.isNaN(priceEuros) || priceEuros < 0 || (priceEuros > 0 && priceEuros < 0.5)) {
    status.textContent = '❌ Vul een geldige prijs in (0 = gratis, anders minimaal 0,50)';
    status.style.color = 'var(--danger)';
    return;
  }
  if (!file) return (status.textContent = '❌ Kies eerst een bestand'), (status.style.color = 'var(--danger)');
  if (file.size > 8 * 1024 * 1024) return (status.textContent = '❌ Bestand is groter dan 8 MB'), (status.style.color = 'var(--danger)');

  btn.disabled = true;
  status.textContent = 'Opslaan...';
  status.style.color = 'var(--muted)';

  try {
    const { product } = await api('POST', '/store/admin/products', {
      guildId: state.guildId,
      name,
      description: $('sp_description').value.trim() || null,
      priceCents: Math.round(priceEuros * 100),
      currency: $('sp_currency').value,
      version: $('sp_version').value.trim() || null,
      changelog: $('sp_changelog').value.trim() || null,
      category: $('sp_category').value.trim() || null,
      imageUrls: $('sp_images').value.split('\n').map((l) => l.trim()).filter(Boolean),
    });

    try {
      const dataBase64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1]);
        r.onerror = () => reject(new Error('Bestand lezen mislukt'));
        r.readAsDataURL(file);
      });
      await api('POST', `/store/admin/product-file/${product.id}`, {
        guildId: state.guildId,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        dataBase64,
      });
    } catch (uploadErr) {
      // Geen product zonder bestand laten staan.
      await api('DELETE', `/store/admin/products/${product.id}`, { guildId: state.guildId }).catch(() => {});
      throw uploadErr;
    }

    $('sp_name').value = '';
    $('sp_description').value = '';
    $('sp_price').value = '';
    $('sp_version').value = '';
    $('sp_changelog').value = '';
    $('sp_category').value = '';
    $('sp_images').value = '';
    $('sp_file').value = '';
    status.textContent = '✅ Toegevoegd';
    status.style.color = 'var(--success)';
    await loadShop();
  } catch (err) {
    status.textContent = `❌ ${err.message}`;
    status.style.color = 'var(--danger)';
  } finally {
    btn.disabled = false;
  }
});

// ---- Entry point ----
(async function init() {
  showLoginErrorFromUrl();

  let me;
  try {
    me = await api('GET', '/auth/me');
  } catch {
    showScreen('login');
    return;
  }

  state.guilds = me.guilds || [];

  const savedGuildId = loadSelectedGuild();
  const savedGuild = state.guilds.find((g) => g.id === savedGuildId);

  if (savedGuild) {
    state.guildId = savedGuild.id;
    state.guildName = savedGuild.name;
    boot();
  } else {
    clearSelectedGuild();
    renderPicker();
    showScreen('picker');
  }
})();
