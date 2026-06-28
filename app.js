'use strict';

/* ============================================================
   Storage keys
   ============================================================ */
const STORAGE_KEYS = {
  priceList: 'spark.priceList',
  projects: 'spark.projects',
  activeProjectId: 'spark.activeProjectId',
  projectPrefix: 'spark.project.'
};

// Room types and the price-list groups visible inside each. Flooring/Paint/Doors
// are the same group across Interior/General, Bedroom, and Living/Common — one
// shared item pool, but every room instance still keeps its own selections.
const ROOM_TYPES = {
  Bathroom: { groups: ['Vanity & Countertop', 'Tub & Shower', 'Tile'] },
  Kitchen: { groups: ['Cabinets', 'Countertops & Tile', 'Appliances'] },
  'Interior/General': { groups: ['Flooring', 'Paint', 'Doors', 'Pest Control', 'General'] },
  'Systems & Structure': { groups: ['HVAC', 'Electrical', 'Structural', 'Insulation & Drywall'] },
  Exterior: { groups: ['Fence', 'Siding', 'Windows', 'Garage', 'Trees', 'Other'] },
  Bedroom: { groups: ['Flooring', 'Paint', 'Doors', 'Closet'] },
  'Living/Common Areas': { groups: ['Flooring', 'Paint', 'Doors', 'Lighting'] }
};

/* ============================================================
   State (single in-memory source of truth, mirrors localStorage)
   ============================================================ */
const state = {
  ready: false,
  priceList: [],
  projects: [],
  activeProjectId: null,
  activeProject: null,
  view: 'projects', // projects | priceList | project
  priceListEditMode: false,
  priceListReturnView: 'projects',
  expandedGroups: new Set(), // keys like "Kitchen::Cabinets"
  addItemOpenKey: null, // group key whose "add item" form is open
  newProjectFormOpen: false,
  renamingProjectId: null,
  addRoomPanelOpen: false,
  expandedRooms: new Set(), // room instanceIds
  expandedRoomGroups: new Set(), // keys like "room-123::Flooring"
  addRoomItemOpenKey: null, // room-group key whose "add custom item" form is open
  deferredInstallPrompt: null
};

/* ============================================================
   Storage helpers
   ============================================================ */
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.warn('[storage] failed to parse', key, err);
    return fallback;
  }
}

function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

/* ============================================================
   CSV parsing (RFC4180-ish: quoted fields, embedded commas, "" escapes)
   ============================================================ */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') { inQuotes = true; } // quote only special at field start
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const header = rows.shift();
  return rows.map((cols) => {
    const obj = {};
    header.forEach((key, idx) => { obj[key] = cols[idx] !== undefined ? cols[idx] : ''; });
    return obj;
  });
}

/* ============================================================
   Price list: load on first run, lookups, grouping
   ============================================================ */
async function ensurePriceListLoaded() {
  const stored = loadJSON(STORAGE_KEYS.priceList, null);
  if (stored && stored.length) {
    state.priceList = stored;
    return;
  }
  const res = await fetch('repair-items.csv');
  const text = await res.text();
  const rows = parseCSV(text);
  state.priceList = rows.map((r) => ({
    id: r.id,
    name: r.name,
    cost: Number(r.cost),
    unit: r.unit,
    section: r.section,
    group: r.group
  }));
  saveJSON(STORAGE_KEYS.priceList, state.priceList);
}

function findPriceItem(id) {
  return state.priceList.find((item) => item.id === id);
}

// Returns ordered [{ section, groups: [{ group, items: [...] }] }], preserving first-seen order.
function groupedPriceList() {
  const sectionOrder = [];
  const sectionMap = new Map();

  for (const item of state.priceList) {
    if (!sectionMap.has(item.section)) {
      sectionMap.set(item.section, new Map());
      sectionOrder.push(item.section);
    }
    const groupMap = sectionMap.get(item.section);
    if (!groupMap.has(item.group)) groupMap.set(item.group, []);
    groupMap.get(item.group).push(item);
  }

  return sectionOrder.map((section) => ({
    section,
    groups: Array.from(sectionMap.get(section).entries()).map(([group, items]) => ({ group, items }))
  }));
}

function groupKey(section, group) {
  return `${section}::${group}`;
}

/* ============================================================
   Projects: CRUD against spark.projects (index) + spark.project.<id> (full state)
   ============================================================ */
function projectKey(id) {
  return STORAGE_KEYS.projectPrefix + id;
}

function loadProject(id) {
  return loadJSON(projectKey(id), null);
}

function createProject(name) {
  const id = `proj-${Date.now()}`;
  const now = new Date().toISOString();
  const project = {
    id, name, arv: 0, targetAcquisition: 0,
    rooms: [], photos: [], roomCounters: {},
    createdAt: now, updatedAt: now
  };
  saveJSON(projectKey(id), project);
  state.projects.push({ id, name, createdAt: now });
  saveJSON(STORAGE_KEYS.projects, state.projects);
  return project;
}

function selectProject(id) {
  const project = loadProject(id);
  if (!project) return;
  state.activeProject = project;
  state.activeProjectId = id;
  saveJSON(STORAGE_KEYS.activeProjectId, id);
  state.view = 'project';
  state.addRoomPanelOpen = false;
  state.expandedRooms = new Set();
  state.expandedRoomGroups = new Set();
  state.addRoomItemOpenKey = null;
}

function saveActiveProject() {
  if (!state.activeProject) return;
  state.activeProject.updatedAt = new Date().toISOString();
  saveJSON(projectKey(state.activeProject.id), state.activeProject);
}

function renameProject(id, newName) {
  const trimmed = newName.trim();
  if (!trimmed) return;
  const entry = state.projects.find((p) => p.id === id);
  if (entry) entry.name = trimmed;
  saveJSON(STORAGE_KEYS.projects, state.projects);

  if (state.activeProject && state.activeProject.id === id) {
    state.activeProject.name = trimmed;
    saveActiveProject();
  } else {
    const project = loadProject(id);
    if (project) {
      project.name = trimmed;
      project.updatedAt = new Date().toISOString();
      saveJSON(projectKey(id), project);
    }
  }
}

/* ============================================================
   Room instances: add/remove per type, each with its own group set
   ============================================================ */
function createRoomGroups(type) {
  const groups = {};
  for (const groupName of ROOM_TYPES[type].groups) {
    groups[groupName] = { items: {}, noActionNeeded: false };
  }
  return groups;
}

// Monotonic per-type counter on the project, so a label is never reused after
// a delete (counting current rooms of a type would re-mint a number that's
// still in use by a sibling, e.g. deleting "Bathroom 1" then adding a new
// bathroom while "Bathroom 2" exists must not also produce "Bathroom 2").
function nextRoomLabel(type) {
  if (!state.activeProject.roomCounters) state.activeProject.roomCounters = {};
  const next = (state.activeProject.roomCounters[type] || 0) + 1;
  state.activeProject.roomCounters[type] = next;
  return `${type} ${next}`;
}

function addRoomInstance(type) {
  if (!ROOM_TYPES[type]) return;
  const room = {
    instanceId: `room-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    label: nextRoomLabel(type),
    groups: createRoomGroups(type)
  };
  state.activeProject.rooms.push(room);
  saveActiveProject();
}

function removeRoomInstance(instanceId) {
  state.activeProject.rooms = state.activeProject.rooms.filter((r) => r.instanceId !== instanceId);
  saveActiveProject();
}

function findRoom(instanceId) {
  return state.activeProject.rooms.find((r) => r.instanceId === instanceId);
}

function roomGroupKey(instanceId, groupName) {
  return `${instanceId}::${groupName}`;
}

// Group names are unique across sections by design (see ROOM_TYPES), so a
// plain group-name filter is unambiguous regardless of which room type asks.
function itemsInGroup(groupName) {
  return state.priceList.filter((item) => item.group === groupName);
}

/* ============================================================
   Line items: selection, qty, per-project cost override, custom items
   ============================================================ */
function selectRoomItem(instanceId, groupName, itemId) {
  const room = findRoom(instanceId);
  if (!room || room.groups[groupName].items[itemId]) return;
  room.groups[groupName].items[itemId] = { qty: 1 };
  saveActiveProject();
}

function deselectRoomItem(instanceId, groupName, itemId) {
  const room = findRoom(instanceId);
  if (!room) return;
  delete room.groups[groupName].items[itemId];
  saveActiveProject();
}

function adjustRoomItemQty(instanceId, groupName, itemId, delta) {
  const room = findRoom(instanceId);
  const entry = room?.groups[groupName].items[itemId];
  if (!entry) return;
  const next = entry.qty + delta;
  if (next <= 0) delete room.groups[groupName].items[itemId];
  else entry.qty = next;
  saveActiveProject();
}

function setRoomItemCostOverride(instanceId, groupName, itemId, rawValue) {
  const room = findRoom(instanceId);
  const entry = room?.groups[groupName].items[itemId];
  if (!entry) return;
  const num = Number(rawValue);
  if (Number.isFinite(num)) entry.unitCostOverride = num;
  saveActiveProject();
}

function toggleNoActionNeeded(instanceId, groupName) {
  const room = findRoom(instanceId);
  if (!room) return;
  room.groups[groupName].noActionNeeded = !room.groups[groupName].noActionNeeded;
  saveActiveProject();
}

// Ad-hoc items live only on the room (id prefix "room-custom-"), carrying
// their own name/cost/unit inline since they have no global price-list entry.
function addCustomRoomItem(instanceId, groupName, { name, cost, unit }) {
  const room = findRoom(instanceId);
  if (!room) return null;
  const itemId = `room-custom-${Date.now()}`;
  room.groups[groupName].items[itemId] = { qty: 1, name, cost: Number(cost) || 0, unit };
  saveActiveProject();
  return itemId;
}

function resolveRoomItemDisplay(itemId, entry) {
  const priceItem = findPriceItem(itemId);
  if (priceItem) return { name: priceItem.name, unit: priceItem.unit, baseCost: priceItem.cost };
  return { name: entry.name || 'Custom item', unit: entry.unit || '', baseCost: Number(entry.cost) || 0 };
}

function roomTotal(room) {
  let total = 0;
  for (const groupState of Object.values(room.groups)) {
    for (const [itemId, entry] of Object.entries(groupState.items)) {
      const { baseCost } = resolveRoomItemDisplay(itemId, entry);
      const cost = Number.isFinite(entry.unitCostOverride) ? entry.unitCostOverride : baseCost;
      total += entry.qty * cost;
    }
  }
  return total;
}

function projectTotal() {
  if (!state.activeProject) return 0;
  return state.activeProject.rooms.reduce((sum, r) => sum + roomTotal(r), 0);
}

function deleteProject(id) {
  state.projects = state.projects.filter((p) => p.id !== id);
  saveJSON(STORAGE_KEYS.projects, state.projects);
  localStorage.removeItem(projectKey(id));

  if (state.activeProjectId === id) {
    state.activeProjectId = null;
    state.activeProject = null;
    saveJSON(STORAGE_KEYS.activeProjectId, null);
    state.view = 'projects';
  }
}

/* ============================================================
   Render — single entry point, re-renders #app from state
   ============================================================ */
function render() {
  const root = document.getElementById('app');
  if (!state.ready) {
    root.innerHTML = renderLoading();
    return;
  }

  let body;
  if (state.view === 'priceList') body = renderPriceListBody();
  else if (state.view === 'project') body = renderProjectBody() + renderProjectFooter();
  else body = renderProjectsBody();

  root.innerHTML = `${renderHeader()}${body}`;
}

function renderLoading() {
  return `
    <div class="flex-1 flex items-center justify-center">
      <div class="text-center">
        <div class="w-10 h-10 mx-auto mb-3 rounded-full border-4 border-accent-200 border-t-accent-600 animate-spin"></div>
        <p class="text-sm text-slate-500">Loading Spark Estimator…</p>
      </div>
    </div>
  `;
}

const PRICE_TAG_ICON = `<svg class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor"><path d="M5.5 3A2.5 2.5 0 003 5.5v9A2.5 2.5 0 005.5 17h9a2.5 2.5 0 002.5-2.5v-9A2.5 2.5 0 0014.5 3h-9zM7 7h6v1.5H7V7zm0 3h6v1.5H7V10z"/></svg>`;
const BACK_ICON = `<svg class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M12.79 5.23a.75.75 0 010 1.06L9.06 10l3.73 3.71a.75.75 0 11-1.06 1.06l-4.25-4.24a.75.75 0 010-1.06l4.25-4.24a.75.75 0 011.06 0z" clip-rule="evenodd"/></svg>`;
const PENCIL_ICON = `<svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-8.5 8.5a2 2 0 01-.878.506l-3 .857a.5.5 0 01-.618-.618l.857-3a2 2 0 01.506-.878l8.5-8.5z"/></svg>`;
const TRASH_ICON = `<svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 112 0v6a1 1 0 11-2 0V8z" clip-rule="evenodd"/></svg>`;

function renderHeader() {
  if (state.view === 'priceList') {
    return `
      <header class="sticky top-0 z-40 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
        <div class="px-4 py-3 flex items-center gap-2">
          <button data-action="back-from-price-list" class="min-h-[44px] min-w-[44px] -ml-2 text-slate-600 dark:text-slate-300" aria-label="Back">${BACK_ICON}</button>
          <h1 class="text-lg font-semibold flex-1">Price List</h1>
          <button
            data-action="toggle-edit-mode"
            class="min-h-[44px] px-3 rounded-lg text-sm font-medium ${state.priceListEditMode ? 'bg-accent-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200'}"
          >${state.priceListEditMode ? 'Done' : 'Edit'}</button>
        </div>
      </header>
    `;
  }

  if (state.view === 'project' && state.activeProject) {
    return `
      <header class="sticky top-0 z-40 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
        <div class="px-4 py-3 flex items-center justify-between gap-2">
          <div class="min-w-0">
            <p class="text-xs text-slate-400">Spark Estimator</p>
            <h1 class="text-lg font-semibold truncate">${escapeHTML(state.activeProject.name)}</h1>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button data-action="open-price-list" class="min-h-[44px] min-w-[44px] text-slate-500" aria-label="Price list">${PRICE_TAG_ICON}</button>
            <button data-action="switch-project" class="min-h-[44px] px-3 rounded-lg bg-slate-100 dark:bg-slate-800 text-sm font-medium">Switch</button>
          </div>
        </div>
      </header>
    `;
  }

  return `
    <header class="sticky top-0 z-40 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
      <div class="px-4 py-3 flex items-center justify-between">
        <h1 class="text-lg font-semibold">Spark Estimator</h1>
        <button data-action="open-price-list" class="min-h-[44px] min-w-[44px] text-slate-500" aria-label="Price list">${PRICE_TAG_ICON}</button>
      </div>
    </header>
  `;
}

function renderProjectsBody() {
  return `
    <main class="flex-1 px-4 py-4 pb-10">
      ${state.projects.length === 0 ? renderEmptyProjects() : renderProjectList()}
      ${renderNewProjectArea()}
    </main>
  `;
}

function renderEmptyProjects() {
  return `
    <div class="text-center py-12">
      <p class="text-sm text-slate-500 mb-1">No projects yet</p>
      <p class="text-xs text-slate-400">Create one to start estimating repairs.</p>
    </div>
  `;
}

function renderProjectList() {
  return `<div class="space-y-2 mb-4">${state.projects.map(renderProjectRow).join('')}</div>`;
}

function renderProjectRow(p) {
  if (state.renamingProjectId === p.id) {
    return `
      <form data-action="submit-rename-project" data-id="${p.id}" class="bg-white dark:bg-slate-900 rounded-xl border border-accent-300 p-3 flex items-center gap-2">
        <input name="name" value="${escapeAttr(p.name)}" required class="flex-1 min-h-[44px] text-sm bg-slate-50 dark:bg-slate-800 rounded-lg px-2 border border-slate-200 dark:border-slate-700" />
        <button type="submit" class="min-h-[44px] px-3 rounded-lg bg-accent-600 text-white text-sm font-medium">Save</button>
        <button type="button" data-action="cancel-rename-project" class="min-h-[44px] px-2 text-sm text-slate-500">Cancel</button>
      </form>
    `;
  }

  return `
    <div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center">
      <button data-action="select-project" data-id="${p.id}" class="flex-1 min-h-[44px] px-4 py-3 text-left">
        <span class="font-medium text-sm block">${escapeHTML(p.name)}</span>
        <span class="text-xs text-slate-400">${new Date(p.createdAt).toLocaleDateString()}</span>
      </button>
      <button data-action="open-rename-project" data-id="${p.id}" class="min-h-[44px] min-w-[44px] text-slate-400" aria-label="Rename ${escapeAttr(p.name)}">${PENCIL_ICON}</button>
      <button data-action="delete-project" data-id="${p.id}" class="min-h-[44px] min-w-[44px] mr-1 text-red-400" aria-label="Delete ${escapeAttr(p.name)}">${TRASH_ICON}</button>
    </div>
  `;
}

function renderNewProjectArea() {
  if (!state.newProjectFormOpen) {
    return `
      <button data-action="open-new-project" class="w-full min-h-[44px] rounded-xl border-2 border-dashed border-accent-300 text-accent-600 font-medium text-sm">
        + New Project
      </button>
    `;
  }
  return `
    <form data-action="submit-new-project" class="bg-white dark:bg-slate-900 rounded-xl border border-accent-300 p-3 flex items-center gap-2">
      <input name="name" placeholder="Project name (e.g. 412 Maple St)" required class="flex-1 min-h-[44px] text-sm bg-slate-50 dark:bg-slate-800 rounded-lg px-2 border border-slate-200 dark:border-slate-700" />
      <button type="submit" class="min-h-[44px] px-3 rounded-lg bg-accent-600 text-white text-sm font-medium">Create</button>
      <button type="button" data-action="cancel-new-project" class="min-h-[44px] px-2 text-sm text-slate-500">Cancel</button>
    </form>
  `;
}

function renderProjectBody() {
  const rooms = state.activeProject.rooms;
  return `
    <main class="flex-1 px-4 py-4 pb-28">
      ${rooms.length === 0 ? renderEmptyRooms() : renderRoomList(rooms)}
      ${renderAddRoomArea()}
    </main>
  `;
}

function renderProjectFooter() {
  if (!state.activeProject) return '';
  return `
    <footer class="sticky-footer sticky bottom-0 z-30 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 px-4 py-3 flex items-center justify-between shadow-[0_-2px_8px_rgba(0,0,0,0.04)]">
      <span class="text-sm text-slate-500">Repair total</span>
      <span class="text-lg font-bold tabular-nums">$${projectTotal().toFixed(2)}</span>
    </footer>
  `;
}

function renderEmptyRooms() {
  return `
    <div class="text-center py-10">
      <p class="text-sm text-slate-500 mb-1">No rooms yet</p>
      <p class="text-xs text-slate-400">Add a room to start selecting repairs.</p>
    </div>
  `;
}

function renderRoomList(rooms) {
  return `<div class="space-y-2 mb-4">${rooms.map(renderRoomCard).join('')}</div>`;
}

const CHEVRON_ICON = `<svg class="w-4 h-4 shrink-0 transition-transform" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.25a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z" clip-rule="evenodd" /></svg>`;

function renderRoomCard(room) {
  const expanded = state.expandedRooms.has(room.instanceId);
  const total = roomTotal(room);
  return `
    <div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div class="flex items-center px-4 min-h-[56px]">
        <button data-action="toggle-room" data-id="${room.instanceId}" class="flex-1 py-3 text-left">
          <p class="font-medium text-sm">${escapeHTML(room.label)}</p>
          <p class="text-xs text-slate-400 tabular-nums">${total > 0 ? `$${total.toFixed(2)}` : escapeHTML(room.type)}</p>
        </button>
        <button data-action="delete-room" data-id="${room.instanceId}" class="min-h-[44px] min-w-[44px] text-red-400" aria-label="Remove ${escapeAttr(room.label)}">${TRASH_ICON}</button>
        <button data-action="toggle-room" data-id="${room.instanceId}" class="min-h-[44px] min-w-[44px] flex items-center justify-center text-slate-400 ${expanded ? '[&>svg]:rotate-180' : ''}">
          ${CHEVRON_ICON}
        </button>
      </div>
      ${expanded ? renderRoomGroups(room) : ''}
    </div>
  `;
}

function renderRoomGroups(room) {
  return `
    <div class="border-t border-slate-100 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
      ${Object.keys(room.groups).map((g) => renderRoomGroupPanel(room, g)).join('')}
    </div>
  `;
}

function renderRoomGroupPanel(room, groupName) {
  const key = roomGroupKey(room.instanceId, groupName);
  const expanded = state.expandedRoomGroups.has(key);
  const gs = room.groups[groupName];
  const selCount = Object.keys(gs.items).length;
  return `
    <div>
      <button data-action="toggle-room-group" data-key="${key}"
        class="w-full min-h-[44px] px-4 py-3 flex items-center justify-between text-left">
        <span class="font-medium text-sm">${escapeHTML(groupName)}</span>
        <span class="flex items-center gap-2 text-xs text-slate-400">
          ${gs.noActionNeeded ? '<span class="text-green-600 font-medium">✓ no action</span>' : selCount > 0 ? `<span>${selCount} selected</span>` : ''}
          <span class="${expanded ? 'rotate-180' : ''} transition-transform inline-block">
            ${CHEVRON_ICON}
          </span>
        </span>
      </button>
      ${expanded ? renderRoomGroupBody(room, groupName, key, gs) : ''}
    </div>
  `;
}

function renderRoomGroupBody(room, groupName, key, gs) {
  const available = itemsInGroup(groupName).filter((item) => !gs.items[item.id]);
  const selected = Object.entries(gs.items);
  return `
    <div class="px-4 pb-3 border-t border-slate-100 dark:border-slate-800 space-y-3">
      <button data-action="toggle-no-action-needed"
        data-instance-id="${room.instanceId}" data-group="${escapeAttr(groupName)}"
        class="min-h-[44px] flex items-center gap-2 text-sm ${gs.noActionNeeded ? 'text-green-600' : 'text-slate-500'}">
        <span class="w-5 h-5 rounded border flex items-center justify-center shrink-0 ${gs.noActionNeeded ? 'bg-green-500 border-green-500 text-white text-xs' : 'border-slate-300 dark:border-slate-600'}">${gs.noActionNeeded ? '✓' : ''}</span>
        No action needed
      </button>
      ${gs.noActionNeeded ? '' : `
        ${selected.length > 0 ? `
          <div class="space-y-2">
            <p class="text-xs uppercase tracking-wide text-slate-400 pt-1">Selected</p>
            ${selected.map(([id, entry]) => renderSelectedRoomItem(room.instanceId, groupName, id, entry)).join('')}
          </div>
        ` : ''}
        ${available.length > 0 ? `
          <div class="space-y-1">
            <p class="text-xs uppercase tracking-wide text-slate-400 pt-1">Available</p>
            ${available.map((item) => `
              <div class="flex items-center gap-2 py-1">
                <div class="flex-1 min-w-0">
                  <p class="text-sm truncate">${escapeHTML(item.name)}</p>
                  <p class="text-xs text-slate-400 tabular-nums">$${item.cost.toFixed(2)} / ${escapeHTML(item.unit)}</p>
                </div>
                <button data-action="select-room-item"
                  data-instance-id="${room.instanceId}" data-group="${escapeAttr(groupName)}" data-item-id="${item.id}"
                  class="shrink-0 min-h-[36px] px-3 rounded-lg bg-accent-50 dark:bg-slate-800 text-accent-600 text-xs font-medium">+ Add</button>
              </div>
            `).join('')}
          </div>
        ` : ''}
        ${renderAddRoomItemForm(room.instanceId, groupName, key)}
      `}
    </div>
  `;
}

function renderSelectedRoomItem(instanceId, groupName, itemId, entry) {
  const { name, unit, baseCost } = resolveRoomItemDisplay(itemId, entry);
  const unitCost = Number.isFinite(entry.unitCostOverride) ? entry.unitCostOverride : baseCost;
  return `
    <div class="bg-accent-50 dark:bg-slate-800 rounded-lg px-3 py-2">
      <div class="flex items-center gap-2">
        <p class="text-sm font-medium flex-1 truncate">${escapeHTML(name)}</p>
        <button data-action="deselect-room-item"
          data-instance-id="${instanceId}" data-group="${escapeAttr(groupName)}" data-item-id="${itemId}"
          class="min-h-[36px] min-w-[36px] text-slate-400 text-base leading-none shrink-0">✕</button>
      </div>
      <div class="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1">
        <div class="flex items-center gap-1">
          <button data-action="adjust-room-item-qty"
            data-instance-id="${instanceId}" data-group="${escapeAttr(groupName)}" data-item-id="${itemId}" data-delta="-1"
            class="min-h-[32px] min-w-[32px] rounded-lg bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-sm font-bold">−</button>
          <span class="text-sm tabular-nums w-6 text-center">${entry.qty}</span>
          <button data-action="adjust-room-item-qty"
            data-instance-id="${instanceId}" data-group="${escapeAttr(groupName)}" data-item-id="${itemId}" data-delta="1"
            class="min-h-[32px] min-w-[32px] rounded-lg bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-sm font-bold">+</button>
          <span class="text-xs text-slate-400">${escapeHTML(unit)}</span>
        </div>
        <div class="flex items-center gap-1 ml-auto">
          <span class="text-xs text-slate-400">$/unit</span>
          <input data-action="edit-room-item-cost"
            data-instance-id="${instanceId}" data-group="${escapeAttr(groupName)}" data-item-id="${itemId}"
            type="number" step="0.01" value="${unitCost}"
            class="w-20 h-8 text-sm bg-white dark:bg-slate-700 rounded-lg px-2 border border-slate-200 dark:border-slate-600 tabular-nums" />
        </div>
        <p class="text-xs text-slate-500 tabular-nums ml-auto">= $${(entry.qty * unitCost).toFixed(2)}</p>
      </div>
    </div>
  `;
}

function renderAddRoomItemForm(instanceId, groupName, key) {
  if (state.addRoomItemOpenKey !== key) {
    return `
      <button data-action="open-add-room-item" data-key="${key}"
        class="min-h-[44px] text-sm text-accent-600 font-medium">+ Custom item</button>
    `;
  }
  return `
    <form data-action="submit-add-room-item"
      data-instance-id="${instanceId}" data-group="${escapeAttr(groupName)}"
      class="flex flex-wrap items-center gap-2">
      <input name="name" placeholder="Item name" required class="flex-1 min-h-[44px] text-sm bg-white dark:bg-slate-800 rounded-lg px-2 border border-slate-200 dark:border-slate-700" />
      <input name="cost" type="number" step="0.01" placeholder="Cost" class="w-20 min-h-[44px] text-sm bg-white dark:bg-slate-800 rounded-lg px-2 border border-slate-200 dark:border-slate-700" />
      <input name="unit" placeholder="Unit" class="w-20 min-h-[44px] text-sm bg-white dark:bg-slate-800 rounded-lg px-2 border border-slate-200 dark:border-slate-700" />
      <button type="submit" class="min-h-[44px] px-3 rounded-lg bg-accent-600 text-white text-sm font-medium">Add</button>
      <button type="button" data-action="cancel-add-room-item" class="min-h-[44px] px-2 text-sm text-slate-500">Cancel</button>
    </form>
  `;
}

function renderAddRoomArea() {
  if (!state.addRoomPanelOpen) {
    return `
      <button data-action="open-add-room" class="w-full min-h-[44px] rounded-xl border-2 border-dashed border-accent-300 text-accent-600 font-medium text-sm">
        + Add Room
      </button>
    `;
  }
  return `
    <div class="bg-white dark:bg-slate-900 rounded-xl border border-accent-300 p-3">
      <div class="flex items-center justify-between mb-2">
        <p class="text-sm font-medium">Choose a room type</p>
        <button data-action="cancel-add-room" class="min-h-[44px] px-2 text-sm text-slate-500">Cancel</button>
      </div>
      <div class="grid grid-cols-2 gap-2">
        ${Object.keys(ROOM_TYPES).map((type) => `
          <button data-action="add-room" data-type="${escapeAttr(type)}" class="min-h-[44px] px-3 rounded-lg bg-slate-100 dark:bg-slate-800 text-sm font-medium text-left">${escapeHTML(type)}</button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderPriceListBody() {
  return `
    <main class="flex-1 px-4 py-4 pb-10">
      <p class="text-xs uppercase tracking-wide text-slate-400 mb-3">Standard price list</p>
      ${groupedPriceList().map(renderSection).join('')}
    </main>
  `;
}

function renderSection(section) {
  return `
    <section class="mb-5">
      <h2 class="text-sm font-semibold text-accent-700 dark:text-accent-400 mb-2">${escapeHTML(section.section)}</h2>
      <div class="space-y-2">
        ${section.groups.map((g) => renderGroup(section.section, g)).join('')}
      </div>
    </section>
  `;
}

function renderGroup(sectionName, g) {
  const key = groupKey(sectionName, g.group);
  const expanded = state.expandedGroups.has(key);
  const subtotal = g.items.reduce((sum, item) => sum + (Number.isFinite(item.cost) ? item.cost : 0), 0);

  return `
    <div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <button
        data-action="toggle-group"
        data-key="${key}"
        class="w-full min-h-[44px] px-4 py-3 flex items-center justify-between text-left"
      >
        <span class="font-medium text-sm">${escapeHTML(g.group)}</span>
        <span class="flex items-center gap-2 text-xs text-slate-400">
          <span>${g.items.length} item${g.items.length === 1 ? '' : 's'}</span>
          <svg class="w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.25a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z" clip-rule="evenodd" />
          </svg>
        </span>
      </button>
      ${expanded ? renderGroupItems(sectionName, g) : ''}
    </div>
  `;
}

function renderGroupItems(sectionName, g) {
  const key = groupKey(sectionName, g.group);
  return `
    <div class="border-t border-slate-100 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
      ${g.items.map((item) => renderPriceItemRow(item)).join('')}
    </div>
    <div class="px-4 py-2 border-t border-slate-100 dark:border-slate-800">
      ${state.priceListEditMode ? renderAddItemArea(sectionName, g.group, key) : ''}
    </div>
  `;
}

function renderPriceItemRow(item) {
  if (state.priceListEditMode) {
    return `
      <div class="px-4 py-2 flex items-center gap-2">
        <input
          data-action="edit-item-field" data-id="${item.id}" data-field="name"
          value="${escapeAttr(item.name)}"
          class="flex-1 min-h-[44px] text-sm bg-slate-50 dark:bg-slate-800 rounded-lg px-2 border border-slate-200 dark:border-slate-700"
        />
        <input
          data-action="edit-item-field" data-id="${item.id}" data-field="cost"
          type="number" step="0.01" value="${item.cost}"
          class="w-20 min-h-[44px] text-sm bg-slate-50 dark:bg-slate-800 rounded-lg px-2 border border-slate-200 dark:border-slate-700"
        />
        <input
          data-action="edit-item-field" data-id="${item.id}" data-field="unit"
          value="${escapeAttr(item.unit)}"
          class="w-20 min-h-[44px] text-sm bg-slate-50 dark:bg-slate-800 rounded-lg px-2 border border-slate-200 dark:border-slate-700"
        />
        <button
          data-action="delete-item" data-id="${item.id}"
          class="min-h-[44px] min-w-[44px] text-red-600 text-sm font-medium"
          aria-label="Delete ${escapeAttr(item.name)}"
        >✕</button>
      </div>
    `;
  }

  return `
    <div class="px-4 py-2 flex items-center justify-between text-sm">
      <span>${escapeHTML(item.name)}</span>
      <span class="text-slate-500 tabular-nums">$${item.cost.toFixed(2)} / ${escapeHTML(item.unit)}</span>
    </div>
  `;
}

function renderAddItemArea(sectionName, groupName, key) {
  if (state.addItemOpenKey !== key) {
    return `
      <button data-action="open-add-item" data-key="${key}" class="min-h-[44px] text-sm text-accent-600 font-medium">
        + Add item
      </button>
    `;
  }

  return `
    <form data-action="submit-add-item" data-section="${escapeAttr(sectionName)}" data-group="${escapeAttr(groupName)}" class="flex flex-wrap items-center gap-2 py-1">
      <input name="name" placeholder="Item name" required class="flex-1 min-h-[44px] text-sm bg-slate-50 dark:bg-slate-800 rounded-lg px-2 border border-slate-200 dark:border-slate-700" />
      <input name="cost" type="number" step="0.01" placeholder="Cost" required class="w-20 min-h-[44px] text-sm bg-slate-50 dark:bg-slate-800 rounded-lg px-2 border border-slate-200 dark:border-slate-700" />
      <input name="unit" placeholder="Unit" required class="w-20 min-h-[44px] text-sm bg-slate-50 dark:bg-slate-800 rounded-lg px-2 border border-slate-200 dark:border-slate-700" />
      <button type="submit" class="min-h-[44px] px-3 rounded-lg bg-accent-600 text-white text-sm font-medium">Add</button>
      <button type="button" data-action="cancel-add-item" class="min-h-[44px] px-2 text-sm text-slate-500">Cancel</button>
    </form>
  `;
}

function escapeHTML(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str) {
  return escapeHTML(str);
}

/* ============================================================
   Event delegation — one listener per event type on #app
   ============================================================ */
function attachEventListeners() {
  const root = document.getElementById('app');

  root.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el) return;

    switch (el.dataset.action) {
      case 'toggle-edit-mode':
        state.priceListEditMode = !state.priceListEditMode;
        state.addItemOpenKey = null;
        render();
        break;
      case 'toggle-group':
        toggleSet(state.expandedGroups, el.dataset.key);
        render();
        break;
      case 'open-add-item':
        state.addItemOpenKey = el.dataset.key;
        render();
        break;
      case 'cancel-add-item':
        state.addItemOpenKey = null;
        render();
        break;
      case 'delete-item':
        if (confirm('Delete this item from the price list?')) {
          state.priceList = state.priceList.filter((i) => i.id !== el.dataset.id);
          saveJSON(STORAGE_KEYS.priceList, state.priceList);
          render();
        }
        break;
      case 'open-price-list':
        state.priceListReturnView = state.view;
        state.view = 'priceList';
        render();
        break;
      case 'back-from-price-list':
        state.view = state.priceListReturnView || 'projects';
        render();
        break;
      case 'switch-project':
        state.view = 'projects';
        render();
        break;
      case 'open-new-project':
        state.newProjectFormOpen = true;
        render();
        break;
      case 'cancel-new-project':
        state.newProjectFormOpen = false;
        render();
        break;
      case 'select-project':
        selectProject(el.dataset.id);
        render();
        break;
      case 'open-rename-project':
        state.renamingProjectId = el.dataset.id;
        render();
        break;
      case 'cancel-rename-project':
        state.renamingProjectId = null;
        render();
        break;
      case 'delete-project':
        if (confirm('Delete this project? This cannot be undone.')) {
          deleteProject(el.dataset.id);
          render();
        }
        break;
      case 'open-add-room':
        state.addRoomPanelOpen = true;
        render();
        break;
      case 'cancel-add-room':
        state.addRoomPanelOpen = false;
        render();
        break;
      case 'add-room':
        addRoomInstance(el.dataset.type);
        state.addRoomPanelOpen = false;
        render();
        break;
      case 'delete-room':
        if (confirm('Remove this room and its selections?')) {
          removeRoomInstance(el.dataset.id);
          render();
        }
        break;
      case 'toggle-room':
        toggleSet(state.expandedRooms, el.dataset.id);
        render();
        break;
      case 'toggle-room-group':
        toggleSet(state.expandedRoomGroups, el.dataset.key);
        render();
        break;
      case 'select-room-item':
        selectRoomItem(el.dataset.instanceId, el.dataset.group, el.dataset.itemId);
        render();
        break;
      case 'deselect-room-item':
        deselectRoomItem(el.dataset.instanceId, el.dataset.group, el.dataset.itemId);
        render();
        break;
      case 'adjust-room-item-qty':
        adjustRoomItemQty(el.dataset.instanceId, el.dataset.group, el.dataset.itemId, Number(el.dataset.delta));
        render();
        break;
      case 'toggle-no-action-needed':
        toggleNoActionNeeded(el.dataset.instanceId, el.dataset.group);
        render();
        break;
      case 'open-add-room-item':
        state.addRoomItemOpenKey = el.dataset.key;
        render();
        break;
      case 'cancel-add-room-item':
        state.addRoomItemOpenKey = null;
        render();
        break;
    }
  });

  // Text/number edits commit on blur ("change"), not on every keystroke,
  // so re-rendering the whole tree never steals focus mid-type.
  root.addEventListener('change', (event) => {
    const el = event.target.closest('[data-action="edit-item-field"]');
    if (el) {
      const item = findPriceItem(el.dataset.id);
      if (!item) return;
      const field = el.dataset.field;
      item[field] = field === 'cost' ? Number(el.value) : el.value;
      saveJSON(STORAGE_KEYS.priceList, state.priceList);
      render();
      return;
    }
    const costEl = event.target.closest('[data-action="edit-room-item-cost"]');
    if (costEl) {
      setRoomItemCostOverride(costEl.dataset.instanceId, costEl.dataset.group, costEl.dataset.itemId, costEl.value);
      render();
    }
  });

  root.addEventListener('submit', (event) => {
    const addItemForm = event.target.closest('[data-action="submit-add-item"]');
    if (addItemForm) {
      event.preventDefault();
      const data = new FormData(addItemForm);
      const newItem = {
        id: `custom-${Date.now()}`,
        name: String(data.get('name') || '').trim(),
        cost: Number(data.get('cost')) || 0,
        unit: String(data.get('unit') || '').trim(),
        section: addItemForm.dataset.section,
        group: addItemForm.dataset.group
      };
      if (!newItem.name) return;
      state.priceList.push(newItem);
      saveJSON(STORAGE_KEYS.priceList, state.priceList);
      state.addItemOpenKey = null;
      render();
      return;
    }

    const newProjectForm = event.target.closest('[data-action="submit-new-project"]');
    if (newProjectForm) {
      event.preventDefault();
      const data = new FormData(newProjectForm);
      const name = String(data.get('name') || '').trim();
      if (!name) return;
      const project = createProject(name);
      selectProject(project.id);
      state.newProjectFormOpen = false;
      render();
      return;
    }

    const renameForm = event.target.closest('[data-action="submit-rename-project"]');
    if (renameForm) {
      event.preventDefault();
      const data = new FormData(renameForm);
      renameProject(renameForm.dataset.id, String(data.get('name') || ''));
      state.renamingProjectId = null;
      render();
      return;
    }

    const addRoomItemForm = event.target.closest('[data-action="submit-add-room-item"]');
    if (addRoomItemForm) {
      event.preventDefault();
      const data = new FormData(addRoomItemForm);
      const name = String(data.get('name') || '').trim();
      if (!name) return;
      addCustomRoomItem(addRoomItemForm.dataset.instanceId, addRoomItemForm.dataset.group, {
        name,
        cost: Number(data.get('cost')) || 0,
        unit: String(data.get('unit') || '').trim()
      });
      state.addRoomItemOpenKey = null;
      render();
    }
  });
}

function toggleSet(set, key) {
  if (set.has(key)) set.delete(key);
  else set.add(key);
}

/* ============================================================
   PWA: service worker registration + install prompt
   ============================================================ */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('[sw] registration failed', err);
    });
  });
}

function registerInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    render();
  });
}

/* ============================================================
   Init
   ============================================================ */
async function init() {
  await ensurePriceListLoaded();
  state.projects = loadJSON(STORAGE_KEYS.projects, []);
  state.activeProjectId = loadJSON(STORAGE_KEYS.activeProjectId, null);

  if (state.activeProjectId) {
    const project = loadProject(state.activeProjectId);
    if (project) {
      state.activeProject = project;
      state.view = 'project';
    } else {
      state.activeProjectId = null;
      saveJSON(STORAGE_KEYS.activeProjectId, null);
    }
  }

  state.ready = true;
  attachEventListeners();
  render();
}

registerServiceWorker();
registerInstallPrompt();
document.addEventListener('DOMContentLoaded', init);
