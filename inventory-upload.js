// SAP S/4HANA Inventory Bulk Upload — Node.js (zero Python dependency)
const XLSX = require('xlsx');
const https = require('https');
const path = require('path');
const fs = require('fs');

const API_URL = 'https://my428151-api.s4hana.cloud.sap/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV/A_MaterialDocumentHeader';
const USERNAME = 'SPS_INTEGRATION';
const PASSWORD = String.raw`\AvP(dSdU8Ydq&N/6WLrdgxk@UL=52Y(s]W4)>ew`;
const BATCH_SIZE = 500;
const TIMEOUT = 120000;
const MAX_RETRY = 2;

const REQUIRED_COLUMNS = [
  'DocumentDate', 'PostingDate', 'ReferenceDocument', 'Material',
  'Plant', 'StorageLocation', 'GoodsMovementType', 'GoodsMovementReasonCode',
  'QuantityInEntryUnit', 'GdsMvtExtAmtInCoCodeCrcy'
];

const OPTIONAL_COLUMNS = [
  'CtrlPostgForExtWhseMgmtSyst', 'GoodsMovementCode',
  'MaterialDocumentHeaderText', 'InventoryStockType'
];

function basicAuth() {
  return 'Basic ' + Buffer.from(USERNAME + ':' + PASSWORD).toString('base64');
}

function httpsRequest(method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_URL);
    const opts = {
      hostname: url.hostname, port: 443, path: url.pathname + url.search,
      method, headers: { ...headers, 'Authorization': basicAuth() },
      timeout: TIMEOUT, rejectUnauthorized: false
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function detectHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const vals = rows[i].map(v => String(v || '').trim());
    if (vals.includes('DocumentDate') && vals.includes('PostingDate') && vals.includes('Material')) {
      return i;
    }
  }
  return 0; // fallback: assume first row is header
}

function parseExcel(filePath, sheetName) {
  const wb = XLSX.readFile(filePath);
  const sheet = sheetName || wb.SheetNames[0];
  const data = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: '' });
  if (!data.length) throw new Error('Excel file is empty');

  const headerIdx = detectHeaderRow(data);
  const headers = data[headerIdx].map(h => String(h || '').trim());
  const rows = data.slice(headerIdx + 1).filter(r => r.some(c => c !== '' && c !== undefined));

  const records = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const excelRow = headerIdx + i + 2;
    try {
      const get = (name) => {
        const idx = headers.indexOf(name);
        const v = idx >= 0 && idx < row.length ? row[idx] : '';
        return v === undefined || v === null ? '' : v;
      };

      // Check required fields
      for (const f of REQUIRED_COLUMNS) {
        const v = get(f);
        if (v === '' || v === undefined || v === null) throw new Error(`Row ${excelRow}: ${f} must not be empty`);
      }

      const qty = parseFloat(get('QuantityInEntryUnit'));
      if (isNaN(qty)) throw new Error(`Row ${excelRow}: QuantityInEntryUnit is not a valid number`);
      const amt = parseFloat(get('GdsMvtExtAmtInCoCodeCrcy'));
      if (isNaN(amt)) throw new Error(`Row ${excelRow}: GdsMvtExtAmtInCoCodeCrcy is not a valid number`);

      const record = {
        Material: String(get('Material')),
        Plant: String(get('Plant')),
        StorageLocation: String(get('StorageLocation')),
        GoodsMovementType: String(get('GoodsMovementType')),
        GoodsMovementReasonCode: String(get('GoodsMovementReasonCode')),
        QuantityInEntryUnit: String(qty),
        GdsMvtExtAmtInCoCodeCrcy: String(amt),
        _docDate: String(get('DocumentDate')),
        _postingDate: String(get('PostingDate')),
        _reference: String(get('ReferenceDocument')),
        _ctrlPostg: get('CtrlPostgForExtWhseMgmtSyst') || '2',
        _goodsMvtCode: get('GoodsMovementCode') || '05',
        _headerText: get('MaterialDocumentHeaderText') || '',
        _inventoryStockType: get('InventoryStockType') || '',
        _excelRow: excelRow
      };
      records.push(record);
    } catch (e) {
      errors.push({ excelRow, error: e.message });
    }
  }

  if (errors.length) {
    throw new Error('Validation failed:\n' + errors.slice(0, 20).map(e => `Row ${e.excelRow}: ${e.error}`).join('\n'));
  }
  if (!records.length) throw new Error('No valid data rows found');

  return records;
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

async function fetchCsrfToken() {
  const res = await httpsRequest('GET', '', { 'x-csrf-token': 'fetch', 'Accept': 'application/json' });
  if (res.status !== 200) throw new Error('CSRF fetch failed: HTTP ' + res.status);
  const token = res.headers['x-csrf-token'];
  if (!token) throw new Error('No CSRF token in response');
  return token;
}

async function postBatch(token, chunk) {
  const first = chunk[0];
  const items = chunk.map(r => {
    const item = {
      Material: r.Material, Plant: r.Plant, StorageLocation: r.StorageLocation,
      GoodsMovementType: r.GoodsMovementType, GoodsMovementReasonCode: r.GoodsMovementReasonCode,
      QuantityInEntryUnit: r.QuantityInEntryUnit, GdsMvtExtAmtInCoCodeCrcy: r.GdsMvtExtAmtInCoCodeCrcy
    };
    if (r._inventoryStockType) item.InventoryStockType = r._inventoryStockType;
    return item;
  });

  const payload = {
    DocumentDate: first._docDate,
    PostingDate: first._postingDate,
    CtrlPostgForExtWhseMgmtSyst: first._ctrlPostg,
    GoodsMovementCode: first._goodsMvtCode,
    ReferenceDocument: first._reference,
    to_MaterialDocumentItem: items
  };
  if (first._headerText) payload.MaterialDocumentHeaderText = first._headerText;

  let currentToken = token;
  for (let attempt = 1; attempt <= MAX_RETRY + 1; attempt++) {
    const headers = { 'x-csrf-token': currentToken, 'Content-Type': 'application/json', 'Accept': 'application/json' };
    const res = await httpsRequest('POST', '', headers, payload);
    if (res.status === 200 || res.status === 201) return { ok: true, data: tryParse(res.body), payload };
    if (res.status === 403 && attempt <= MAX_RETRY) {
      currentToken = await fetchCsrfToken();
      continue;
    }
    return { ok: false, status: res.status, body: res.body, payload };
  }
}

function tryParse(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

async function run(filePath, sheetName, outputDir) {
  console.log('=== SAP S/4HANA Bulk Inventory Upload ===');
  console.log('File:', filePath);
  console.log('Sheet:', sheetName || 'default');

  const records = parseExcel(filePath, sheetName);
  console.log('Validated:', records.length, 'rows');

  const chunks = chunkArray(records, BATCH_SIZE);
  console.log('Batches:', chunks.length, '(size:', BATCH_SIZE + ')');

  const token = await fetchCsrfToken();
  console.log('CSRF token obtained');

  const successDocs = [];
  const failedDocs = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const excelRows = chunk.map(r => r._excelRow);
    console.log(`Batch ${i + 1}/${chunks.length}: ${chunk.length} rows (Excel ${excelRows[0]}-${excelRows[excelRows.length - 1]})...`);
    const result = await postBatch(token, chunk);

    if (result.ok) {
      const body = result.data.d || result.data;
      const docNo = body.MaterialDocument || '';
      const docYear = body.MaterialDocumentYear || '';
      successDocs.push({
        batch_no: i + 1, row_count: chunk.length,
        excel_row_start: excelRows[0], excel_row_end: excelRows[excelRows.length - 1],
        material_document: docNo, material_document_year: docYear
      });
      console.log(`  OK: ${docNo} / ${docYear}`);
    } else {
      failedDocs.push({
        batch_no: i + 1, row_count: chunk.length,
        excel_row_start: excelRows[0], excel_row_end: excelRows[excelRows.length - 1],
        status_code: result.status, response_text: result.body, payload: result.payload
      });
      console.log(`  FAILED: HTTP ${result.status}`);
    }
  }

  const summary = {
    run_time: new Date().toISOString(),
    api_url: API_URL,
    excel_file: filePath,
    sheet_name: sheetName,
    total_rows: records.length,
    batch_size: BATCH_SIZE,
    total_batches: chunks.length,
    success_batches: successDocs.length,
    failed_batches: failedDocs.length
  };

  // Save results
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonFile = path.join(outputDir, `result_${Date.now()}.json`);
  const xlsxFile = path.join(outputDir, `inventory_upload_result_${ts}.xlsx`);

  const fullResult = { summary, success: successDocs, failed: failedDocs };
  fs.writeFileSync(jsonFile, JSON.stringify(fullResult, null, 2));

  // Write Excel results
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(successDocs.length ? successDocs : [{ message: 'no success' }]), 'success');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(failedDocs.length ? failedDocs : [{ message: 'no failure' }]), 'failed');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([summary]), 'summary');
  XLSX.writeFile(wb, xlsxFile);

  console.log('=== Done ===');
  console.log(JSON.stringify(summary));

  return { summary, successDocs, failedDocs, jsonFile, xlsxFile };
}

// CLI
if (require.main === module) {
  const [,, fpath, sname, odir] = process.argv;
  if (!fpath) { console.log('Usage: node inventory-upload.js <excel_file> [sheet_name] [output_dir]'); process.exit(1); }
  const outDir = odir || path.dirname(fpath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  run(fpath, sname || 'InventoryUploadTemplate', outDir)
    .then(r => console.log('JSON:', r.jsonFile, '\nExcel:', r.xlsxFile))
    .catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { run };
