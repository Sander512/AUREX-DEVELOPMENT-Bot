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
      giveaways: ['Giveaways', 'Overzicht van lopende en afgelopen giveaways in deze server.'],
      welcome: ['Welkomstbericht', 'Stel in wat er gebeurt zodra iemand de server joint.'],
      verify: ['Verificatie', 'Stel het verificatie-paneel en de bijbehorende rol in.'],
      rules: ['Regels', 'Stel de regels-embed in die met /rules-send geplaatst wordt.'],
      shop: ['Webshop', 'Beheer producten, bekijk aankopen en stuur update-DM\'s naar kopers.'],
      orders: ['Bestellingen', 'Alle bestellingen met betaalstatus, direct bijgewerkt via de betaal-webhook.'],
    };
    $('pageTitle').textContent = titles[btn.dataset.tab][0];
    $('pageSubtitle').textContent = titles[btn.dataset.tab][1];

    if (btn.dataset.tab === 'tickets') loadTickets();
    if (btn.dataset.tab === 'giveaways') loadGiveaways();
    if (btn.dataset.tab === 'welcome') loadWelcomeConfig();
    if (btn.dataset.tab === 'verify') loadVerifyConfig();
    if (btn.dataset.tab === 'rules') loadRulesConfig();
    if (btn.dataset.tab === 'shop') loadShop();
    if (btn.dataset.tab === 'orders') loadOrders(true);
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

// ---- Giveaways tab (alleen overzicht) ----
async function loadGiveaways() {
  const activeList = $('activeGiveawaysList');
  const endedList = $('endedGiveawaysList');
  activeList.innerHTML = '<div class="empty-state">Laden...</div>';
  endedList.innerHTML = '<div class="empty-state">Laden...</div>';

  try {
    const [{ giveaways: active }, { giveaways: ended }] = await Promise.all([
      api('GET', `/giveaways/guild/${state.guildId}?status=active`),
      api('GET', `/giveaways/guild/${state.guildId}?status=ended`),
    ]);

    renderGiveawayList(activeList, active, 'Geen lopende giveaways.', (g) => `eindigt over ${formatCountdown(g.endsAt)}`);
    renderGiveawayList(endedList, ended, 'Nog geen afgelopen giveaways.', (g) =>
      g.winners?.length ? `${g.winners.length} winnaar(s)` : 'niemand deed mee'
    );
  } catch (err) {
    activeList.innerHTML = `<div class="empty-state">Fout bij laden: ${escapeHtml(err.message)}</div>`;
    endedList.innerHTML = '';
  }
}

function formatCountdown(endsAt) {
  const ms = endsAt - Date.now();
  if (ms <= 0) return 'zo';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}u`;
  return `${Math.round(hours / 24)}d`;
}

function renderGiveawayList(container, giveaways, emptyText, badgeText) {
  if (giveaways.length === 0) {
    container.innerHTML = `<div class="empty-state">${emptyText}</div>`;
    return;
  }

  container.innerHTML = '';
  giveaways.forEach((g) => {
    const row = document.createElement('div');
    row.className = 'ticket-row';
    row.innerHTML = `
      <div>🎉 ${escapeHtml(g.prize)} — ${g.winnerCount} winnaar(s), ${g.entryCount} deelnemer(s)</div>
      <span class="ticket-badge">${escapeHtml(badgeText(g))}</span>
    `;
    container.appendChild(row);
  });
}

$('refreshGiveawaysBtn').addEventListener('click', loadGiveaways);

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

// ---- Productfoto's ----
const MAX_PHOTOS = 15;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_VIDEOS = 3;
const isVideoType = (type) => /^video\/(mp4|webm)$/.test(type);
let newProductPhotos = []; // File[] — index 0 = cover

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('Foto lezen mislukt'));
    r.readAsDataURL(file);
  });
}

async function filesToImagePayload(files) {
  const out = [];
  for (const f of files) {
    out.push({ fileName: f.name, mimeType: f.type, dataBase64: await fileToBase64(f) });
  }
  return out;
}

// Foto's in porties van max ~30 MB naar de server (15 grote foto's in één request
// zijn te zwaar). Bij replace=true vervangt de eerste portie alles; de rest komt erachter.
async function uploadPhotoFiles(productId, files, replace) {
  const MAX_BATCH_BYTES = 30 * 1024 * 1024;
  let batch = [];
  let bytes = 0;
  let first = true;
  const flush = async () => {
    if (batch.length === 0) return;
    await api('POST', `/store/admin/product-images/${productId}`, {
      guildId: state.guildId,
      images: batch,
      replace: !!replace && first,
    });
    first = false;
    batch = [];
    bytes = 0;
  };
  for (const f of files) {
    if (batch.length > 0 && bytes + f.size > MAX_BATCH_BYTES) await flush();
    batch.push(...(await filesToImagePayload([f])));
    bytes += f.size;
  }
  await flush();
}

function validatePhotoFiles(files, alreadyThere = 0, videosThere = 0) {
  if (alreadyThere + files.length > MAX_PHOTOS) return `Maximaal ${MAX_PHOTOS} foto's en video's per product`;
  let videos = videosThere;
  for (const f of files) {
    if (isVideoType(f.type)) {
      videos += 1;
      if (videos > MAX_VIDEOS) return `Maximaal ${MAX_VIDEOS} video's per product`;
      if (f.size > MAX_VIDEO_BYTES) return `"${f.name}" is groter dan 50 MB`;
    } else if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) {
      return `"${f.name}" is geen PNG, JPG, WEBP, GIF, MP4 of WEBM`;
    } else if (f.size > MAX_PHOTO_BYTES) {
      return `"${f.name}" is groter dan 8 MB`;
    }
  }
  return null;
}

// Voorbeeld-element voor een foto of video (video: stilstaand eerste beeld + ▶).
function mediaPreviewEl(url, isVideo, alt) {
  if (!isVideo) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = alt;
    img.loading = 'lazy';
    return img;
  }
  const video = document.createElement('video');
  video.src = `${url}#t=0.1`;
  video.muted = true;
  video.preload = 'metadata';
  video.playsInline = true;
  video.setAttribute('aria-label', alt);
  return video;
}

function playBadge() {
  const b = document.createElement('span');
  b.className = 'photo-play';
  b.textContent = '▶';
  return b;
}

function renderNewPhotoPreview() {
  const box = $('sp_photoPreview');
  box.textContent = '';
  newProductPhotos.forEach((file, i) => {
    const item = document.createElement('div');
    item.className = `photo-item${i === 0 ? ' is-cover' : ''}`;
    const vid = isVideoType(file.type);
    item.appendChild(mediaPreviewEl(URL.createObjectURL(file), vid, file.name));
    if (vid) item.appendChild(playBadge());
    if (i === 0) {
      const badge = document.createElement('span');
      badge.className = 'photo-badge';
      badge.textContent = 'Cover';
      item.appendChild(badge);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'photo-remove';
    remove.textContent = '✕';
    remove.title = 'Verwijderen';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      newProductPhotos.splice(i, 1);
      renderNewPhotoPreview();
    });
    item.appendChild(remove);
    item.title = i === 0 ? 'Cover-foto' : 'Klik om deze foto de cover te maken';
    item.addEventListener('click', () => {
      if (i === 0) return;
      const [f] = newProductPhotos.splice(i, 1);
      newProductPhotos.unshift(f);
      renderNewPhotoPreview();
    });
    box.appendChild(item);
  });
}

$('sp_photos').addEventListener('change', (e) => {
  const picked = Array.from(e.target.files);
  e.target.value = ''; // zodat je dezelfde foto later opnieuw kunt kiezen
  const error = validatePhotoFiles(picked, newProductPhotos.length, newProductPhotos.filter((f) => isVideoType(f.type)).length);
  if (error) {
    $('addProductStatus').textContent = `❌ ${error}`;
    $('addProductStatus').style.color = 'var(--danger)';
    return;
  }
  newProductPhotos = newProductPhotos.concat(picked);
  renderNewPhotoPreview();
});

// Fotobeheer per bestaand product: cover kiezen, verwijderen, toevoegen.
function renderProductPhotos(row, product, reload) {
  const box = row.querySelector('.product-photos');
  box.textContent = '';
  const images = product.images || [];

  images.forEach((img, i) => {
    const item = document.createElement('div');
    item.className = `photo-item${i === 0 ? ' is-cover' : ''}`;
    item.appendChild(mediaPreviewEl(img.url, img.type === 'video', `${product.name} ${i + 1}`));
    if (img.type === 'video') item.appendChild(playBadge());
    if (i === 0) {
      const badge = document.createElement('span');
      badge.className = 'photo-badge';
      badge.textContent = 'Cover';
      item.appendChild(badge);
    } else {
      const cover = document.createElement('button');
      cover.type = 'button';
      cover.className = 'photo-cover-btn';
      cover.textContent = img.type === 'video' ? 'Zet vooraan' : 'Maak cover';
      cover.addEventListener('click', async () => {
        cover.disabled = true;
        try {
          await api('POST', `/store/admin/product-images/${product.id}/cover`, { guildId: state.guildId, imageId: img.id });
          await reload();
        } catch (err) {
          alert(`Mislukt: ${err.message}`);
          cover.disabled = false;
        }
      });
      item.appendChild(cover);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'photo-remove';
    remove.textContent = '✕';
    remove.title = 'Verwijderen';
    remove.addEventListener('click', async () => {
      if (!confirm(img.type === 'video' ? 'Deze video verwijderen?' : 'Deze foto verwijderen?')) return;
      remove.disabled = true;
      try {
        await api('DELETE', `/store/admin/product-images/${product.id}/${img.id}`, { guildId: state.guildId });
        await reload();
      } catch (err) {
        alert(`Mislukt: ${err.message}`);
        remove.disabled = false;
      }
    });
    item.appendChild(remove);
    box.appendChild(item);
  });

  if (images.length < MAX_PHOTOS) {
    const label = document.createElement('label');
    label.className = 'photo-add';
    label.textContent = '+ Foto\'s / video';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm';
    input.multiple = true;
    input.hidden = true;
    input.addEventListener('change', async () => {
      const picked = Array.from(input.files);
      input.value = '';
      if (picked.length === 0) return;
      const error = validatePhotoFiles(picked, images.length, images.filter((m) => m.type === 'video').length);
      if (error) return alert(error);
      label.textContent = 'Uploaden...';
      try {
        await uploadPhotoFiles(product.id, picked, false);
        await reload();
      } catch (err) {
        alert(`Mislukt: ${err.message}`);
        label.textContent = '+ Foto\'s / video';
      }
    });
    label.appendChild(input);
    box.appendChild(label);
  }

  if (images.length === 0 && (product.linkImageUrls || []).length > 0) {
    const note = document.createElement('span');
    note.className = 'hint';
    note.textContent = `(${product.linkImageUrls.length} foto-link(s) in gebruik; geüploade foto's komen hier altijd vóór)`;
    box.appendChild(note);
  }
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
        <div class="product-photos photo-strip"></div>
      </div>
      <div class="product-admin-actions">
        <button class="btn btn-ghost btn-small" data-action="edit">✏️ Bewerken</button>
        <button class="btn btn-ghost btn-small" data-action="toggle">${p.active ? 'Deactiveren' : 'Activeren'}</button>
        <button class="btn btn-ghost btn-small" data-action="newfile">📦 Nieuw bestand</button>
        <input type="file" class="newfile-input" hidden />
        <button class="btn btn-ghost btn-small" data-action="notify">🔔 Stuur update</button>
        <button class="btn btn-danger btn-small" data-action="delete">Verwijderen</button>
      </div>
      <div class="product-edit hidden"></div>
    </div>
  `
    )
    .join('');

  list.querySelectorAll('.product-admin-row').forEach((row) => {
    const id = row.dataset.id;
    const product = products.find((p) => p.id === id);
    renderProductPhotos(row, product, loadShop);
    setupProductEdit(row, product);

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

    // Nieuw bestand: vervangt het bestand op de website (kopers downloaden dan
    // altijd de nieuwste) en stuurt op verzoek meteen een DM met het nieuwe
    // bestand naar iedereen die het product al gekocht heeft.
    const newFileInput = row.querySelector('.newfile-input');
    row.querySelector('[data-action="newfile"]').addEventListener('click', () => newFileInput.click());
    newFileInput.addEventListener('change', async () => {
      const file = newFileInput.files[0];
      newFileInput.value = '';
      if (!file) return;
      if (file.size > 1024 * 1024 * 1024) return alert('Bestand is groter dan 1 GB');
      const btn = row.querySelector('[data-action="newfile"]');
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Uploaden...';
      try {
        await api('POST', `/store/admin/product-file/${id}`, {
          guildId: state.guildId,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          dataBase64: await fileToBase64(file),
        });
        const version = prompt(
          `"${file.name}" staat nu op de website.\n\nNieuw versienummer? (leeg laten = versie niet wijzigen)`,
          product.version || ''
        );
        if (version !== null && version.trim() && version.trim() !== (product.version || '')) {
          await api('POST', `/store/admin/products/${id}`, { guildId: state.guildId, version: version.trim() });
        }
        if (confirm('Nieuw bestand staat online. Ook meteen een update-DM met dit bestand sturen naar iedereen die het gekocht heeft?')) {
          const result = await api('POST', `/store/admin/products/${id}/notify`, { guildId: state.guildId, includeFile: true });
          alert(result.message || `DM klaargezet voor ${result.queued} koper(s).`);
        }
        await loadShop();
      } catch (err) {
        alert(`Mislukt: ${err.message}`);
        btn.disabled = false;
        btn.textContent = original;
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

// ---- Product bewerken ----
function setupProductEdit(row, product) {
  const panel = row.querySelector('.product-edit');
  const btn = row.querySelector('[data-action="edit"]');

  btn.addEventListener('click', () => {
    if (!panel.classList.contains('hidden')) {
      panel.classList.add('hidden');
      return;
    }
    panel.innerHTML = `
      <label>Naam</label><input data-f="name" type="text" maxlength="200" />
      <label>Omschrijving</label><textarea data-f="description" rows="3" maxlength="4000"></textarea>
      <div class="edit-row">
        <div><label>Prijs <span class="hint">0 = gratis</span></label><input data-f="price" type="number" step="0.01" min="0" /></div>
        <div><label>Valuta</label><select data-f="currency"><option value="eur">EUR</option><option value="usd">USD</option><option value="gbp">GBP</option></select></div>
        <div><label>Categorie</label><input data-f="category" type="text" maxlength="60" /></div>
        <div><label>Versie</label><input data-f="version" type="text" maxlength="100" /></div>
      </div>
      <label>Changelog</label><textarea data-f="changelog" rows="3" maxlength="4000"></textarea>
      <div class="save-bar">
        <button class="btn btn-primary btn-small" data-f="save">Opslaan</button>
        <button class="btn btn-ghost btn-small" data-f="cancel">Annuleren</button>
        <span class="save-status" data-f="status"></span>
      </div>`;
    const f = (k) => panel.querySelector(`[data-f="${k}"]`);
    f('name').value = product.name || '';
    f('description').value = product.description || '';
    f('price').value = ((product.priceCents || 0) / 100).toFixed(2);
    f('currency').value = product.currency || 'eur';
    f('category').value = product.category || '';
    f('version').value = product.version || '';
    f('changelog').value = product.changelog || '';
    panel.classList.remove('hidden');

    f('cancel').addEventListener('click', () => panel.classList.add('hidden'));
    f('save').addEventListener('click', async () => {
      const status = f('status');
      const price = parseFloat(f('price').value);
      const name = f('name').value.trim();
      if (!name) return (status.textContent = '❌ Naam is verplicht'), (status.style.color = 'var(--danger)');
      if (!Number.isFinite(price) || price < 0) return (status.textContent = '❌ Ongeldige prijs'), (status.style.color = 'var(--danger)');

      f('save').disabled = true;
      status.textContent = 'Opslaan...';
      status.style.color = '';
      try {
        await api('POST', `/store/admin/products/${product.id}`, {
          guildId: state.guildId,
          name,
          description: f('description').value.trim(),
          priceCents: Math.round(price * 100),
          currency: f('currency').value,
          category: f('category').value.trim(),
          version: f('version').value.trim() || null,
          changelog: f('changelog').value.trim() || null,
        });
        await loadShop();
      } catch (err) {
        status.textContent = `❌ ${err.message}`;
        status.style.color = 'var(--danger)';
        f('save').disabled = false;
      }
    });
  });
}

// ---- Bundels ----
let adminProducts = [];

function renderBundleProductChoices() {
  const box = $('bd_products');
  const keep = new Set(Array.from(box.querySelectorAll('input:checked')).map((i) => i.value));
  box.textContent = '';
  const paid = adminProducts.filter((p) => p.priceCents > 0);
  if (paid.length < 2) {
    box.appendChild(Object.assign(document.createElement('p'), { className: 'muted hint', textContent: 'Je hebt minstens 2 betaalde producten nodig om een bundel te maken.' }));
    return;
  }
  paid.forEach((p) => {
    const label = document.createElement('label');
    label.className = 'check-item';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = p.id;
    input.checked = keep.has(p.id);
    label.append(input, ` ${p.name} — ${formatPriceAdmin(p.priceCents, p.currency)}`);
    box.appendChild(label);
  });
}

function renderBundleList(bundles) {
  const list = $('bundleList');
  list.textContent = '';
  if (bundles.length === 0) {
    list.appendChild(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Nog geen bundels.' }));
    return;
  }
  const nameOf = (id) => (adminProducts.find((p) => p.id === id) || {}).name || '(verwijderd product)';
  bundles.forEach((b) => {
    const row = document.createElement('div');
    row.className = 'product-admin-row';
    const info = document.createElement('div');
    info.className = 'product-admin-info';
    const title = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = b.name;
    title.append(strong, ` · −${b.discountPercent}%`);
    if (!b.active) title.append(' ', Object.assign(document.createElement('span'), { className: 'hint', textContent: '(inactief)' }));
    const sub = document.createElement('div');
    sub.className = 'muted';
    sub.style.fontSize = '13px';
    sub.textContent = b.productIds.map(nameOf).join(' + ');
    info.append(title, sub);

    const actions = document.createElement('div');
    actions.className = 'product-admin-actions';
    const toggle = document.createElement('button');
    toggle.className = 'btn btn-ghost btn-small';
    toggle.textContent = b.active ? 'Deactiveren' : 'Activeren';
    toggle.addEventListener('click', async () => {
      try { await api('POST', `/store/admin/bundles/${b.id}`, { guildId: state.guildId, active: !b.active }); await loadBundles(); }
      catch (err) { alert(`Mislukt: ${err.message}`); }
    });
    const del = document.createElement('button');
    del.className = 'btn btn-danger btn-small';
    del.textContent = 'Verwijderen';
    del.addEventListener('click', async () => {
      if (!confirm(`Bundel "${b.name}" verwijderen?`)) return;
      try { await api('DELETE', `/store/admin/bundles/${b.id}`, { guildId: state.guildId }); await loadBundles(); }
      catch (err) { alert(`Mislukt: ${err.message}`); }
    });
    actions.append(toggle, del);
    row.append(info, actions);
    list.appendChild(row);
  });
}

async function loadBundles() {
  renderBundleProductChoices();
  try {
    const { bundles } = await api('GET', `/store/admin/bundles/${state.guildId}`);
    renderBundleList(bundles);
  } catch (err) {
    $('bundleList').textContent = `Fout bij laden: ${err.message}`;
  }
}

$('addBundleBtn').addEventListener('click', async () => {
  const status = $('addBundleStatus');
  const fail = (m) => { status.textContent = `❌ ${m}`; status.style.color = 'var(--danger)'; };
  const productIds = Array.from($('bd_products').querySelectorAll('input:checked')).map((i) => i.value);
  const percent = parseInt($('bd_percent').value, 10);
  if (!$('bd_name').value.trim()) return fail('Geef de bundel een naam');
  if (productIds.length < 2) return fail('Kies minstens 2 producten');
  if (!Number.isInteger(percent) || percent < 1 || percent > 90) return fail('Korting moet tussen 1 en 90% liggen');

  $('addBundleBtn').disabled = true;
  status.textContent = 'Opslaan...';
  status.style.color = '';
  try {
    await api('POST', '/store/admin/bundles', {
      guildId: state.guildId,
      name: $('bd_name').value.trim(),
      description: $('bd_description').value.trim() || null,
      productIds,
      discountPercent: percent,
    });
    $('bd_name').value = '';
    $('bd_description').value = '';
    $('bd_percent').value = '';
    $('bd_products').querySelectorAll('input').forEach((i) => (i.checked = false));
    status.textContent = '✅ Toegevoegd';
    status.style.color = 'var(--success)';
    await loadBundles();
  } catch (err) {
    fail(err.message);
  } finally {
    $('addBundleBtn').disabled = false;
  }
});

// ---- Kortingscodes ----
function codeLabel(c) {
  const value = c.percentOff ? `${c.percentOff}%` : formatPriceAdmin(c.amountOffCents, 'eur');
  const uses = c.maxUses ? `${c.usedCount}/${c.maxUses} gebruikt` : `${c.usedCount}× gebruikt`;
  const exp = c.expiresAt ? ` · geldig tot ${new Date(c.expiresAt).toLocaleDateString('nl-NL')}` : '';
  return `${value} korting · ${uses}${exp}`;
}

async function loadCodes() {
  const list = $('codeList');
  try {
    const { codes } = await api('GET', `/store/admin/discount-codes/${state.guildId}`);
    list.textContent = '';
    if (codes.length === 0) {
      list.appendChild(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Nog geen kortingscodes.' }));
      return;
    }
    codes.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'product-admin-row';
      const info = document.createElement('div');
      info.className = 'product-admin-info';
      const title = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = c.code;
      title.appendChild(strong);
      const expired = c.expiresAt && c.expiresAt < Date.now();
      if (!c.active || expired) title.append(' ', Object.assign(document.createElement('span'), { className: 'hint', textContent: expired ? '(verlopen)' : '(inactief)' }));
      const sub = document.createElement('div');
      sub.className = 'muted';
      sub.style.fontSize = '13px';
      sub.textContent = codeLabel(c);
      info.append(title, sub);

      const actions = document.createElement('div');
      actions.className = 'product-admin-actions';
      const toggle = document.createElement('button');
      toggle.className = 'btn btn-ghost btn-small';
      toggle.textContent = c.active ? 'Deactiveren' : 'Activeren';
      toggle.addEventListener('click', async () => {
        try { await api('POST', `/store/admin/discount-codes/${c.id}`, { guildId: state.guildId, active: !c.active }); await loadCodes(); }
        catch (err) { alert(`Mislukt: ${err.message}`); }
      });
      const del = document.createElement('button');
      del.className = 'btn btn-danger btn-small';
      del.textContent = 'Verwijderen';
      del.addEventListener('click', async () => {
        if (!confirm(`Code ${c.code} verwijderen?`)) return;
        try { await api('DELETE', `/store/admin/discount-codes/${c.id}`, { guildId: state.guildId }); await loadCodes(); }
        catch (err) { alert(`Mislukt: ${err.message}`); }
      });
      actions.append(toggle, del);
      row.append(info, actions);
      list.appendChild(row);
    });
  } catch (err) {
    list.textContent = `Fout bij laden: ${err.message}`;
  }
}

$('dc_type').addEventListener('change', () => {
  const pct = $('dc_type').value === 'percent';
  $('dc_valueLabel').innerHTML = pct ? 'Korting (%) <span class="hint">100 = volledig gratis</span>' : 'Korting (bedrag) <span class="hint">bv. 5 voor €5 korting</span>';
  $('dc_value').placeholder = pct ? '25' : '5.00';
  $('dc_value').step = pct ? '1' : '0.01';
});

$('addCodeBtn').addEventListener('click', async () => {
  const status = $('addCodeStatus');
  const fail = (m) => { status.textContent = `❌ ${m}`; status.style.color = 'var(--danger)'; };
  const pct = $('dc_type').value === 'percent';
  const value = parseFloat($('dc_value').value);
  if (!$('dc_code').value.trim()) return fail('Vul een code in');
  if (!Number.isFinite(value) || value <= 0) return fail('Vul een geldige korting in');
  const maxUsesRaw = $('dc_maxUses').value.trim();
  const expiresRaw = $('dc_expires').value;

  const payload = { guildId: state.guildId, code: $('dc_code').value.trim() };
  if (pct) payload.percentOff = Math.round(value);
  else payload.amountOffCents = Math.round(value * 100);
  if (maxUsesRaw) payload.maxUses = parseInt(maxUsesRaw, 10);
  if (expiresRaw) payload.expiresAt = new Date(`${expiresRaw}T23:59:59`).getTime();

  $('addCodeBtn').disabled = true;
  status.textContent = 'Opslaan...';
  status.style.color = '';
  try {
    await api('POST', '/store/admin/discount-codes', payload);
    ['dc_code', 'dc_value', 'dc_maxUses', 'dc_expires'].forEach((id) => ($(id).value = ''));
    status.textContent = '✅ Toegevoegd';
    status.style.color = 'var(--success)';
    await loadCodes();
  } catch (err) {
    fail(err.message);
  } finally {
    $('addCodeBtn').disabled = false;
  }
});

// ---- Reviews modereren ----
async function loadReviews() {
  const list = $('reviewAdminList');
  try {
    const { reviews } = await api('GET', `/store/admin/reviews/${state.guildId}`);
    list.textContent = '';
    if (reviews.length === 0) {
      list.appendChild(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Nog geen reviews.' }));
      return;
    }
    reviews.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'product-admin-row';
      const info = document.createElement('div');
      info.className = 'product-admin-info';
      const title = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = r.productName || 'Product';
      title.append(strong, `  ${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)} · ${r.username}`);
      info.appendChild(title);
      if (r.body) {
        const body = document.createElement('div');
        body.className = 'muted';
        body.style.fontSize = '13px';
        body.textContent = r.body;
        info.appendChild(body);
      }
      const del = document.createElement('button');
      del.className = 'btn btn-danger btn-small';
      del.textContent = 'Verwijderen';
      del.addEventListener('click', async () => {
        if (!confirm('Deze review verwijderen?')) return;
        try { await api('DELETE', `/store/admin/reviews/${r.id}`, { guildId: state.guildId }); await loadReviews(); }
        catch (err) { alert(`Mislukt: ${err.message}`); }
      });
      row.append(info, del);
      list.appendChild(row);
    });
  } catch (err) {
    list.textContent = `Fout bij laden: ${err.message}`;
  }
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
    adminProducts = products;
    renderProductList(products);
  } catch (err) {
    $('productList').innerHTML = `<div class="empty-state">Fout bij laden: ${escapeHtml(err.message)}</div>`;
  }
  loadBundles();
  loadCodes();
  loadReviews();
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
  if (file.size > 1024 * 1024 * 1024) return (status.textContent = '❌ Bestand is groter dan 1 GB'), (status.style.color = 'var(--danger)');

  const photoError = validatePhotoFiles(newProductPhotos);
  if (photoError) return (status.textContent = `❌ ${photoError}`), (status.style.color = 'var(--danger)');

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

    // Foto's (eerste = cover). Mislukt dit, dan blijft het product gewoon staan.
    let photoError = null;
    if (newProductPhotos.length > 0) {
      try {
        await uploadPhotoFiles(product.id, newProductPhotos, true);
      } catch (err) {
        photoError = err.message;
      }
    }

    $('sp_name').value = '';
    $('sp_description').value = '';
    $('sp_price').value = '';
    $('sp_version').value = '';
    $('sp_changelog').value = '';
    $('sp_category').value = '';
    newProductPhotos = [];
    renderNewPhotoPreview();
    $('sp_file').value = '';
    status.textContent = photoError ? `✅ Toegevoegd, maar foto's mislukten: ${photoError}` : '✅ Toegevoegd';
    status.style.color = photoError ? 'var(--danger)' : 'var(--success)';
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


// ---- Bestellingen & betaalstatussen ----
const ORDER_PAGE_SIZE = 25;
const orderView = { offset: 0, total: 0, status: '', q: '', open: null };

const ORDER_STATUS_LABELS = { pending: 'Wachten op betaling', paid: 'Betaald', failed: 'Mislukt', canceled: 'Geannuleerd' };

function orderMoney(cents, currency) {
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: String(currency || 'eur').toUpperCase() }).format((cents || 0) / 100);
}

function orderDate(ts) {
  return ts ? new Date(ts).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' }) : '—';
}

function orderBadge(status) {
  return `<span class="order-badge order-badge-${escapeHtml(status)}">${escapeHtml(ORDER_STATUS_LABELS[status] || status)}</span>`;
}

function renderOrderStats(counts, revenue) {
  const revenueText = Object.keys(revenue).length
    ? Object.entries(revenue).map(([cur, cents]) => orderMoney(cents, cur)).join(' · ')
    : orderMoney(0, 'eur');
  const stat = (label, value, tone) => `<div class="stat stat-${tone}"><div class="stat-value">${escapeHtml(String(value))}</div><div class="stat-label">${escapeHtml(label)}</div></div>`;
  $('orderStats').innerHTML = [
    stat('Omzet (betaald)', revenueText, 'paid'),
    stat('Betaald', counts.paid, 'paid'),
    stat('Wachten op betaling', counts.pending, 'pending'),
    stat('Mislukt', counts.failed, 'failed'),
    stat('Geannuleerd', counts.canceled, 'canceled'),
  ].join('');
}

async function loadOrders(reset) {
  if (reset) {
    orderView.offset = 0;
    orderView.open = null;
  }
  const list = $('orderList');
  try {
    const qs = new URLSearchParams({ limit: String(ORDER_PAGE_SIZE), offset: String(orderView.offset) });
    if (orderView.status) qs.set('status', orderView.status);
    if (orderView.q) qs.set('q', orderView.q);
    const data = await api('GET', `/store/admin/orders/${state.guildId}?${qs}`);
    orderView.total = data.total;
    renderOrderStats(data.counts, data.revenue);

    list.textContent = '';
    if (data.orders.length === 0) {
      list.innerHTML = '<div class="empty-state">Geen bestellingen gevonden.</div>';
    }
    data.orders.forEach((o) => list.appendChild(orderRow(o)));

    const from = data.total === 0 ? 0 : orderView.offset + 1;
    const to = Math.min(orderView.offset + data.orders.length, data.total);
    $('orderPageInfo').textContent = `${from}–${to} van ${data.total}`;
    $('orderPrevBtn').disabled = orderView.offset === 0;
    $('orderNextBtn').disabled = orderView.offset + ORDER_PAGE_SIZE >= data.total;
  } catch (err) {
    list.innerHTML = `<div class="empty-state">Fout bij laden: ${escapeHtml(err.message)}</div>`;
  }
}

function orderRow(o) {
  const row = document.createElement('div');
  row.className = 'order-admin-row';

  const summary = o.items.map((i) => `${i.quantity}× ${i.name}`).join(', ');
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'order-admin-head';
  head.innerHTML = `
    <span class="order-col-id"><strong>${escapeHtml(o.orderNumber)}</strong><span class="muted">${escapeHtml(orderDate(o.createdAt))}</span></span>
    <span class="order-col-status">${orderBadge(o.status)}</span>
    <span class="order-col-customer">${escapeHtml(o.discordUsername || o.discordId)}<span class="muted">${escapeHtml(summary)}</span></span>
    <span class="order-col-total">${escapeHtml(orderMoney(o.totalCents, o.currency))}</span>`;
  row.appendChild(head);

  const body = document.createElement('div');
  body.className = 'order-admin-detail hidden';
  row.appendChild(body);

  head.addEventListener('click', async () => {
    const opening = body.classList.contains('hidden');
    document.querySelectorAll('.order-admin-detail').forEach((d) => d.classList.add('hidden'));
    if (!opening) return;
    body.classList.remove('hidden');
    await loadOrderDetail(o.orderNumber, body);
  });

  if (orderView.open === o.orderNumber) {
    body.classList.remove('hidden');
    loadOrderDetail(o.orderNumber, body);
  }
  return row;
}

async function loadOrderDetail(orderNumber, body) {
  orderView.open = orderNumber;
  body.innerHTML = '<div class="muted">Laden…</div>';
  try {
    const { order: o, events } = await api('GET', `/store/admin/orders/${state.guildId}/${encodeURIComponent(orderNumber)}`);

    const lines = o.items
      .map((i) => `<tr><td>${escapeHtml(i.name)}${i.version ? ` <span class="muted">v${escapeHtml(i.version)}</span>` : ''}</td><td class="num">${i.quantity}</td><td class="num">${escapeHtml(orderMoney(i.unitCents, o.currency))}</td><td class="num">${escapeHtml(orderMoney(i.finalCents * i.quantity, o.currency))}</td></tr>`)
      .join('');

    const evRows = events.length
      ? events.map((e) => `<li><span class="muted">${escapeHtml(orderDate(e.createdAt))}</span> <strong>${escapeHtml(e.event)}</strong> <span class="muted">(${escapeHtml(e.source)})</span>${e.detail ? ` — ${escapeHtml(e.detail)}` : ''}</li>`).join('')
      : '<li class="muted">Nog geen betaalgebeurtenissen.</li>';

    body.innerHTML = `
      <div class="order-detail-grid">
        <div>
          <table class="order-lines">
            <thead><tr><th>Product</th><th class="num">Aantal</th><th class="num">Prijs</th><th class="num">Totaal</th></tr></thead>
            <tbody>${lines}</tbody>
            <tfoot>
              <tr><td colspan="3">Subtotaal</td><td class="num">${escapeHtml(orderMoney(o.subtotalCents, o.currency))}</td></tr>
              ${o.discountCents > 0 ? `<tr><td colspan="3">Korting${o.discountCode ? ` (${escapeHtml(o.discountCode)})` : ''}</td><td class="num">−${escapeHtml(orderMoney(o.discountCents, o.currency))}</td></tr>` : ''}
              <tr class="order-total"><td colspan="3">Totaal</td><td class="num">${escapeHtml(orderMoney(o.totalCents, o.currency))}</td></tr>
            </tfoot>
          </table>
        </div>
        <dl class="order-meta">
          <dt>Status</dt><dd>${orderBadge(o.status)}</dd>
          <dt>Klant</dt><dd>${escapeHtml(o.discordUsername || '—')} <span class="muted">${escapeHtml(o.discordId)}</span></dd>
          <dt>Aangemaakt</dt><dd>${escapeHtml(orderDate(o.createdAt))}</dd>
          <dt>Betaald op</dt><dd>${escapeHtml(orderDate(o.paidAt))}</dd>
          <dt>Methode</dt><dd>${escapeHtml(o.method || '—')}</dd>
          <dt>Provider</dt><dd>${escapeHtml(o.provider)}${o.providerPaymentId ? ` <span class="muted">${escapeHtml(o.providerPaymentId)}</span>` : ''}</dd>
          <dt>Providerstatus</dt><dd>${escapeHtml(o.providerStatus || '—')}</dd>
        </dl>
      </div>
      ${o.note ? `<div class="order-note">⚠️ ${escapeHtml(o.note)}</div>` : ''}
      <div class="order-events"><h3>Betaallogboek</h3><ul>${evRows}</ul></div>
      ${o.provider === 'mollie' && o.providerPaymentId ? '<div class="save-bar"><button class="btn btn-ghost btn-small" data-sync type="button">↻ Status bij Mollie controleren</button><span class="save-status" data-sync-status></span></div>' : ''}`;

    const syncBtn = body.querySelector('[data-sync]');
    if (syncBtn) {
      syncBtn.addEventListener('click', async () => {
        const status = body.querySelector('[data-sync-status]');
        syncBtn.disabled = true;
        status.textContent = 'Bezig…';
        try {
          await api('POST', `/store/admin/orders/${state.guildId}/${encodeURIComponent(orderNumber)}/sync`);
          await loadOrders(false);
        } catch (err) {
          status.textContent = `❌ ${err.message}`;
          status.style.color = 'var(--danger)';
          syncBtn.disabled = false;
        }
      });
    }
  } catch (err) {
    body.innerHTML = `<div class="empty-state">Fout bij laden: ${escapeHtml(err.message)}</div>`;
  }
}

let orderSearchTimer = null;
$('orderStatusFilter').addEventListener('change', (e) => { orderView.status = e.target.value; loadOrders(true); });
$('orderSearch').addEventListener('input', (e) => {
  clearTimeout(orderSearchTimer);
  orderSearchTimer = setTimeout(() => { orderView.q = e.target.value.trim(); loadOrders(true); }, 300);
});
$('orderRefreshBtn').addEventListener('click', () => loadOrders(false));
$('orderPrevBtn').addEventListener('click', () => { orderView.offset = Math.max(0, orderView.offset - ORDER_PAGE_SIZE); orderView.open = null; loadOrders(false); });
$('orderNextBtn').addEventListener('click', () => { orderView.offset += ORDER_PAGE_SIZE; orderView.open = null; loadOrders(false); });
$('orderExportBtn').addEventListener('click', async () => {
  const btn = $('orderExportBtn');
  btn.disabled = true;
  try {
    const res = await fetch(`/store/admin/orders-export/${state.guildId}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: `aurex-bestellingen-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`Exporteren mislukt: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});
