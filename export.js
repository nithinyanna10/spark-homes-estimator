const ROOM_TYPE_TO_SECTION = {
  Bathroom: 'Bathrooms',
  Kitchen: 'Kitchen',
  'Interior/General': 'Interior/General',
  'Systems & Structure': 'Systems & Structure',
  Exterior: 'Exterior',
  Bedroom: 'Interior/General',
  'Living/Common Areas': 'Interior/General',
};

const EXPORT_COLUMNS = ['Section', 'Room', 'Group', 'Item', 'Quantity', 'Unit', 'Unit Cost', 'Line Total'];

function resolveItemDetails(itemId, itemRecord, priceList) {
  const fromPriceList = priceList.find((p) => p.id === itemId);
  if (fromPriceList) {
    return { name: fromPriceList.name, unit: fromPriceList.unit, cost: fromPriceList.cost };
  }
  if (itemRecord && itemRecord.name != null && itemRecord.cost != null && itemRecord.unit != null) {
    return { name: itemRecord.name, unit: itemRecord.unit, cost: itemRecord.cost };
  }
  return null;
}

function effectiveUnitCost(itemRecord, baseCost) {
  return typeof itemRecord.unitCostOverride === 'number' && Number.isFinite(itemRecord.unitCostOverride)
    ? itemRecord.unitCostOverride
    : baseCost;
}

function roundTo2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function buildExportRows(project, priceList) {
  const rows = [];
  let grandTotal = 0;

  for (const room of project.rooms || []) {
    const section = ROOM_TYPE_TO_SECTION[room.type] || room.type;

    for (const groupName of Object.keys(room.groups || {})) {
      const group = room.groups[groupName];
      const itemIds = Object.keys(group.items || {});
      if (group.noActionNeeded && itemIds.length === 0) continue;

      for (const itemId of itemIds) {
        const itemRecord = group.items[itemId];
        if (!itemRecord || !itemRecord.qty) continue;

        const details = resolveItemDetails(itemId, itemRecord, priceList);
        if (!details) {
          console.warn(`export.js: could not resolve item "${itemId}" in room "${room.label}" / group "${groupName}" — skipping`);
          continue;
        }

        const unitCost = effectiveUnitCost(itemRecord, details.cost);
        const lineTotal = roundTo2(itemRecord.qty * unitCost);
        grandTotal += lineTotal;

        rows.push({
          Section: section,
          Room: room.label,
          Group: groupName,
          Item: details.name,
          Quantity: itemRecord.qty,
          Unit: details.unit,
          'Unit Cost': unitCost,
          'Line Total': lineTotal,
        });
      }
    }
  }

  rows.push({
    Section: '',
    Room: '',
    Group: '',
    Item: 'GRAND TOTAL',
    Quantity: '',
    Unit: '',
    'Unit Cost': '',
    'Line Total': roundTo2(grandTotal),
  });

  return rows;
}

function buildWorkbook(rows) {
  const ws = XLSX.utils.json_to_sheet(rows, { header: EXPORT_COLUMNS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Estimate');
  return wb;
}

function workbookToArrayBuffer(workbook) {
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
}

function sanitizeFilename(name) {
  return name
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '_');
}

function todayStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

const MIME_TO_EXT = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp' };

function extensionForDataUrl(dataUrl) {
  const match = /^data:image\/([a-zA-Z0-9]+);base64,/.exec(dataUrl);
  const subtype = match ? match[1].toLowerCase() : '';
  return MIME_TO_EXT[subtype] || 'jpg';
}

// JSZip's {base64: true} mode expects the raw base64 payload, not the data: URI wrapper.
function stripDataUrlPrefix(dataUrl) {
  return dataUrl.replace(/^data:[^;]+;base64,/, '');
}

async function buildExportZip(project, priceList) {
  const rows = buildExportRows(project, priceList);
  const workbook = buildWorkbook(rows);
  const arrayBuffer = workbookToArrayBuffer(workbook);

  const zip = new JSZip();
  const sanitizedName = sanitizeFilename(project.name);
  zip.file(`${sanitizedName}.xlsx`, arrayBuffer);

  for (const photo of project.photos || []) {
    if (!photo || !photo.dataUrl) {
      console.warn(`export.js: photo "${photo && photo.id}" missing dataUrl — skipping`);
      continue;
    }
    const ext = extensionForDataUrl(photo.dataUrl);
    zip.file(`photos/${photo.id}.${ext}`, stripDataUrlPrefix(photo.dataUrl), { base64: true });
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const filename = `${sanitizedName}_${todayStamp()}.zip`;
  return { blob, filename };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
