# import math
# import json
# from datetime import datetime
# from pathlib import Path
# from typing import Dict, Any, List

# import pandas as pd
# import requests
# from requests.auth import HTTPBasicAuth

# API_URL = "https://my428151-api.s4hana.cloud.sap/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV/A_MaterialDocumentHeader"
# USERNAME = "SPS_INTEGRATION"
# PASSWORD = r"\AvP(dSdU8Ydq&N/6WLrdgxk@UL=52Y(s]W4)>ew"
# DEFAULT_SHEET_NAME = "InventoryUploadTemplate"
# BATCH_SIZE = 500
# TIMEOUT = 120
# MAX_RETRY = 2

# REQUIRED_COLUMNS = [
#     "DocumentDate",
#     "PostingDate",
#     "ReferenceDocument",
#     "Material",
#     "Plant",
#     "StorageLocation",
#     "GoodsMovementType",
#     "GoodsMovementReasonCode",
#     "QuantityInEntryUnit",
#     "GdsMvtExtAmtInCoCodeCrcy",
# ]

# OPTIONAL_COLUMNS = [
#     "CtrlPostgForExtWhseMgmtSyst",
#     "GoodsMovementCode",
#     "MaterialDocumentHeaderText",
# ]


# def choose_file() -> Path:
#     try:
#         import tkinter as tk
#         from tkinter import filedialog
#         root = tk.Tk()
#         root.withdraw()
#         root.attributes("-topmost", True)
#         filename = filedialog.askopenfilename(
#             title="Please select the Excel file for inventory upload",
#             filetypes=[("Excel files", "*.xlsx *.xls")],
#         )
#         root.destroy()
#         if filename:
#             return Path(filename)
#     except Exception:
#         pass
#     entered = input("Please enter the full path to the Excel file: ").strip().strip('"')
#     if not entered:
#         raise FileNotFoundError("No Excel file was selected.")
#     return Path(entered)


# def normalize_str(v):
#     if pd.isna(v):
#         return ""
#     if isinstance(v, pd.Timestamp):
#         return v.strftime("%Y-%m-%dT%H:%M:%S")
#     return str(v).strip()


# def parse_numeric(v, field_name: str, row_no: int) -> float:
#     if pd.isna(v) or str(v).strip() == "":
#         raise ValueError(f"Row {row_no}: field {field_name} must not be empty.")
#     try:
#         return float(v)
#     except Exception:
#         raise ValueError(f"Row {row_no}: field {field_name} is not a valid number: {v}")


# def detect_header_row(file_path: Path, sheet_name: str) -> int:
#     preview = pd.read_excel(file_path, sheet_name=sheet_name, header=None, nrows=20)
#     for idx in range(len(preview)):
#         row_values = [normalize_str(x) for x in preview.iloc[idx].tolist()]
#         if "DocumentDate" in row_values and "PostingDate" in row_values and "Material" in row_values:
#             return idx
#     raise ValueError("Failed to detect the header row automatically. Please check the Excel template.")


# def validate_and_prepare(file_path: Path, sheet_name: str) -> pd.DataFrame:
#     header_row = detect_header_row(file_path, sheet_name)
#     print(f"Detected header row at Excel row {header_row + 1}.")

#     df = pd.read_excel(file_path, sheet_name=sheet_name, header=header_row)
#     df = df.dropna(how="all")
#     df.columns = [str(c).strip() for c in df.columns]

#     missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
#     if missing:
#         raise ValueError(f"Excel is missing required columns: {missing}")

#     keep_cols = REQUIRED_COLUMNS + [c for c in OPTIONAL_COLUMNS if c in df.columns]
#     df = df[keep_cols].copy()
#     df = df.dropna(how="all")
#     df["__excel_row_no__"] = range(header_row + 2, header_row + 2 + len(df))

#     valid_rows = []
#     errors = []

#     for _, row in df.iterrows():
#         row_no = int(row["__excel_row_no__"])
#         try:
#             record = {
#                 "DocumentDate": normalize_str(row["DocumentDate"]),
#                 "PostingDate": normalize_str(row["PostingDate"]),
#                 "ReferenceDocument": normalize_str(row["ReferenceDocument"]),
#                 "Material": normalize_str(row["Material"]),
#                 "Plant": normalize_str(row["Plant"]),
#                 "StorageLocation": normalize_str(row["StorageLocation"]),
#                 "GoodsMovementType": normalize_str(row["GoodsMovementType"]),
#                 "GoodsMovementReasonCode": normalize_str(row["GoodsMovementReasonCode"]),
#                 "QuantityInEntryUnit": parse_numeric(row["QuantityInEntryUnit"], "QuantityInEntryUnit", row_no),
#                 "GdsMvtExtAmtInCoCodeCrcy": parse_numeric(row["GdsMvtExtAmtInCoCodeCrcy"], "GdsMvtExtAmtInCoCodeCrcy", row_no),
#                 "CtrlPostgForExtWhseMgmtSyst": normalize_str(row["CtrlPostgForExtWhseMgmtSyst"]) if "CtrlPostgForExtWhseMgmtSyst" in df.columns else "2",
#                 "GoodsMovementCode": normalize_str(row["GoodsMovementCode"]) if "GoodsMovementCode" in df.columns else "05",
#                 "MaterialDocumentHeaderText": normalize_str(row["MaterialDocumentHeaderText"]) if "MaterialDocumentHeaderText" in df.columns else "",
#                 "__excel_row_no__": row_no,
#             }
#             for f in [
#                 "DocumentDate", "PostingDate", "ReferenceDocument", "Material",
#                 "Plant", "StorageLocation", "GoodsMovementType", "GoodsMovementReasonCode"
#             ]:
#                 if not record[f]:
#                     raise ValueError(f"Row {row_no}: field {f} must not be empty.")
#             valid_rows.append(record)
#         except Exception as e:
#             errors.append({"excel_row_no": row_no, "error": str(e)})

#     if errors:
#         error_text = "\n".join([f"Row {e['excel_row_no']}: {e['error']}" for e in errors[:20]])
#         raise ValueError(f"Excel data validation failed. Sample errors:\n{error_text}")

#     if not valid_rows:
#         raise ValueError("There is no valid data to process in the Excel file.")

#     return pd.DataFrame(valid_rows)


# def build_item(row: pd.Series) -> Dict[str, Any]:
#     return {
#         "Material": row["Material"],
#         "Plant": row["Plant"],
#         "StorageLocation": row["StorageLocation"],
#         "GoodsMovementType": row["GoodsMovementType"],
#         "GoodsMovementReasonCode": row["GoodsMovementReasonCode"],
#         "QuantityInEntryUnit": str(row["QuantityInEntryUnit"]),
#         "GdsMvtExtAmtInCoCodeCrcy": str(row["GdsMvtExtAmtInCoCodeCrcy"]),
#     }


# def build_payload(chunk_df: pd.DataFrame) -> Dict[str, Any]:
#     first = chunk_df.iloc[0]
#     items = [build_item(row) for _, row in chunk_df.iterrows()]
#     payload = {
#         "DocumentDate": first["DocumentDate"],
#         "PostingDate": first["PostingDate"],
#         "CtrlPostgForExtWhseMgmtSyst": first.get("CtrlPostgForExtWhseMgmtSyst", "") or "2",
#         "GoodsMovementCode": first.get("GoodsMovementCode", "") or "05",
#         "ReferenceDocument": first["ReferenceDocument"],
#         "to_MaterialDocumentItem": items,
#     }
#     if first.get("MaterialDocumentHeaderText"):
#         payload["MaterialDocumentHeaderText"] = first["MaterialDocumentHeaderText"]
#     return payload


# def fetch_csrf_token(session: requests.Session) -> str:
#     headers = {"x-csrf-token": "fetch", "Accept": "application/json"}
#     resp = session.get(API_URL, headers=headers, auth=HTTPBasicAuth(USERNAME, PASSWORD), timeout=TIMEOUT)
#     resp.raise_for_status()
#     token = resp.headers.get("x-csrf-token")
#     if not token:
#         raise RuntimeError("Failed to retrieve CSRF token from the API.")
#     return token


# def post_with_retry(session: requests.Session, token: str, payload: Dict[str, Any]) -> requests.Response:
#     headers = {
#         "x-csrf-token": token,
#         "Content-Type": "application/json",
#         "Accept": "application/json",
#     }
#     last_resp = None
#     current_token = token
#     for attempt in range(1, MAX_RETRY + 2):
#         resp = session.post(API_URL, headers=headers, auth=HTTPBasicAuth(USERNAME, PASSWORD), json=payload, timeout=TIMEOUT)
#         last_resp = resp
#         if resp.status_code in (200, 201):
#             return resp
#         if resp.status_code == 403 and attempt <= MAX_RETRY:
#             current_token = fetch_csrf_token(session)
#             headers["x-csrf-token"] = current_token
#             continue
#     return last_resp


# def save_results(base_dir: Path, summary: Dict[str, Any], success_docs: List[Dict[str, Any]], failed_docs: List[Dict[str, Any]]):
#     ts = datetime.now().strftime("%Y%m%d_%H%M%S")
#     json_file = base_dir / f"inventory_upload_result_{ts}.json"
#     excel_file = base_dir / f"inventory_upload_result_{ts}.xlsx"
#     full_result = {"summary": summary, "success_docs": success_docs, "failed_docs": failed_docs}
#     json_file.write_text(json.dumps(full_result, ensure_ascii=False, indent=2), encoding="utf-8")
#     with pd.ExcelWriter(excel_file, engine="openpyxl") as writer:
#         pd.DataFrame(success_docs if success_docs else [{"message": "no success"}]).to_excel(writer, sheet_name="success", index=False)
#         pd.DataFrame(failed_docs if failed_docs else [{"message": "no failure"}]).to_excel(writer, sheet_name="failed", index=False)
#         pd.DataFrame([summary]).to_excel(writer, sheet_name="summary", index=False)
#     return json_file, excel_file


# def main():
#     print("=== SAP S/4HANA Public Cloud - Bulk Inventory Upload ===")
#     file_path = choose_file()
#     if not file_path.exists():
#         raise FileNotFoundError(f"File does not exist: {file_path}")
#     sheet_name = input(f"Enter sheet name (press Enter to use default [{DEFAULT_SHEET_NAME}]): ").strip() or DEFAULT_SHEET_NAME

#     df = validate_and_prepare(file_path, sheet_name)
#     total_rows = len(df)
#     total_batches = math.ceil(total_rows / BATCH_SIZE)
#     print(f"Validation passed. {total_rows} rows will be split into {total_batches} batches (batch size {BATCH_SIZE}).")

#     session = requests.Session()
#     token = fetch_csrf_token(session)
#     print("CSRF token retrieved successfully.")

#     success_docs = []
#     failed_docs = []

#     for batch_index in range(total_batches):
#         start = batch_index * BATCH_SIZE
#         end = min(start + BATCH_SIZE, total_rows)
#         chunk_df = df.iloc[start:end].copy()
#         excel_rows = chunk_df["__excel_row_no__"].tolist()
#         payload = build_payload(chunk_df)
#         print(f"Uploading batch {batch_index + 1}/{total_batches} with {len(chunk_df)} rows (Excel rows {excel_rows[0]}-{excel_rows[-1]})...")
#         resp = post_with_retry(session, token, payload)

#         if resp.status_code in (200, 201):
#             try:
#                 data = resp.json()
#             except Exception:
#                 data = {}
#             body = data.get("d", data)
#             doc_no = body.get("MaterialDocument", "")
#             doc_year = body.get("MaterialDocumentYear", "")
#             success_docs.append({
#                 "batch_no": batch_index + 1,
#                 "row_count": len(chunk_df),
#                 "excel_row_start": excel_rows[0],
#                 "excel_row_end": excel_rows[-1],
#                 "material_document": doc_no,
#                 "material_document_year": doc_year,
#             })
#             print(f"Batch {batch_index + 1} succeeded, material document: {doc_no} / {doc_year}")
#         else:
#             failed_docs.append({
#                 "batch_no": batch_index + 1,
#                 "row_count": len(chunk_df),
#                 "excel_row_start": excel_rows[0],
#                 "excel_row_end": excel_rows[-1],
#                 "status_code": resp.status_code,
#                 "response_text": resp.text,
#                 "payload": payload,
#             })
#             print(f"Batch {batch_index + 1} failed, HTTP {resp.status_code}")
#             print(resp.text)

#     summary = {
#         "run_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
#         "api_url": API_URL,
#         "excel_file": str(file_path.resolve()),
#         "sheet_name": sheet_name,
#         "total_rows": total_rows,
#         "batch_size": BATCH_SIZE,
#         "total_batches": total_batches,
#         "success_batches": len(success_docs),
#         "failed_batches": len(failed_docs),
#     }
#     json_file, excel_file = save_results(file_path.parent, summary, success_docs, failed_docs)
#     print("\n=== Execution finished ===")
#     print(json.dumps(summary, ensure_ascii=False, indent=2))
#     print(f"Result JSON file: {json_file}")
#     print(f"Result Excel file: {excel_file}")


# if __name__ == "__main__":
#     main()

import math
import json
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, List

import pandas as pd
import requests
from requests.auth import HTTPBasicAuth


API_URL = "https://my428151-api.s4hana.cloud.sap/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV/A_MaterialDocumentHeader"
USERNAME = "SPS_INTEGRATION"
PASSWORD = r"\AvP(dSdU8Ydq&N/6WLrdgxk@UL=52Y(s]W4)>ew"
DEFAULT_SHEET_NAME = "InventoryUploadTemplate"
BATCH_SIZE = 500
TIMEOUT = 120
MAX_RETRY = 2


REQUIRED_COLUMNS = [
    "DocumentDate",
    "PostingDate",
    "ReferenceDocument",
    "Material",
    "Plant",
    "StorageLocation",
    "GoodsMovementType",
    "GoodsMovementReasonCode",
    "QuantityInEntryUnit",
    "GdsMvtExtAmtInCoCodeCrcy",
]


OPTIONAL_COLUMNS = [
    "CtrlPostgForExtWhseMgmtSyst",
    "GoodsMovementCode",
    "MaterialDocumentHeaderText",
    "InventoryStockType",  # 新增字段
]


def choose_file() -> Path:
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        filename = filedialog.askopenfilename(
            title="Please select the Excel file for inventory upload",
            filetypes=[("Excel files", "*.xlsx *.xls")],
        )
        root.destroy()
        if filename:
            return Path(filename)
    except Exception:
        pass
    entered = input("Please enter the full path to the Excel file: ").strip().strip('"')
    if not entered:
        raise FileNotFoundError("No Excel file was selected.")
    return Path(entered)


def normalize_str(v):
    if pd.isna(v):
        return ""
    if isinstance(v, pd.Timestamp):
        return v.strftime("%Y-%m-%dT%H:%M:%S")
    return str(v).strip()


def parse_numeric(v, field_name: str, row_no: int) -> float:
    if pd.isna(v) or str(v).strip() == "":
        raise ValueError(f"Row {row_no}: field {field_name} must not be empty.")
    try:
        return float(v)
    except Exception:
        raise ValueError(f"Row {row_no}: field {field_name} is not a valid number: {v}")


def detect_header_row(file_path: Path, sheet_name: str) -> int:
    preview = pd.read_excel(file_path, sheet_name=sheet_name, header=None, nrows=20)
    for idx in range(len(preview)):
        row_values = [normalize_str(x) for x in preview.iloc[idx].tolist()]
        if "DocumentDate" in row_values and "PostingDate" in row_values and "Material" in row_values:
            return idx
    raise ValueError("Failed to detect the header row automatically. Please check the Excel template.")


def validate_and_prepare(file_path: Path, sheet_name: str) -> pd.DataFrame:
    header_row = detect_header_row(file_path, sheet_name)
    print(f"Detected header row at Excel row {header_row + 1}.")

    df = pd.read_excel(file_path, sheet_name=sheet_name, header=header_row)
    df = df.dropna(how="all")
    df.columns = [str(c).strip() for c in df.columns]

    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"Excel is missing required columns: {missing}")

    keep_cols = REQUIRED_COLUMNS + [c for c in OPTIONAL_COLUMNS if c in df.columns]
    df = df[keep_cols].copy()
    df = df.dropna(how="all")
    df["__excel_row_no__"] = range(header_row + 2, header_row + 2 + len(df))

    valid_rows = []
    errors = []

    for _, row in df.iterrows():
        row_no = int(row["__excel_row_no__"])
        try:
            record = {
                "DocumentDate": normalize_str(row["DocumentDate"]),
                "PostingDate": normalize_str(row["PostingDate"]),
                "ReferenceDocument": normalize_str(row["ReferenceDocument"]),
                "Material": normalize_str(row["Material"]),
                "Plant": normalize_str(row["Plant"]),
                "StorageLocation": normalize_str(row["StorageLocation"]),
                "GoodsMovementType": normalize_str(row["GoodsMovementType"]),
                "GoodsMovementReasonCode": normalize_str(row["GoodsMovementReasonCode"]),
                "QuantityInEntryUnit": parse_numeric(row["QuantityInEntryUnit"], "QuantityInEntryUnit", row_no),
                "GdsMvtExtAmtInCoCodeCrcy": parse_numeric(row["GdsMvtExtAmtInCoCodeCrcy"], "GdsMvtExtAmtInCoCodeCrcy", row_no),
                "CtrlPostgForExtWhseMgmtSyst": normalize_str(row["CtrlPostgForExtWhseMgmtSyst"]) if "CtrlPostgForExtWhseMgmtSyst" in df.columns else "2",
                "GoodsMovementCode": normalize_str(row["GoodsMovementCode"]) if "GoodsMovementCode" in df.columns else "05",
                "MaterialDocumentHeaderText": normalize_str(row["MaterialDocumentHeaderText"]) if "MaterialDocumentHeaderText" in df.columns else "",
                "InventoryStockType": normalize_str(row["InventoryStockType"]) if "InventoryStockType" in df.columns else "",
                "__excel_row_no__": row_no,
            }

            for f in [
                "DocumentDate", "PostingDate", "ReferenceDocument", "Material",
                "Plant", "StorageLocation", "GoodsMovementType", "GoodsMovementReasonCode"
            ]:
                if not record[f]:
                    raise ValueError(f"Row {row_no}: field {f} must not be empty.")

            valid_rows.append(record)
        except Exception as e:
            errors.append({"excel_row_no": row_no, "error": str(e)})

    if errors:
        error_text = "\n".join([f"Row {e['excel_row_no']}: {e['error']}" for e in errors[:20]])
        raise ValueError(f"Excel data validation failed. Sample errors:\n{error_text}")

    if not valid_rows:
        raise ValueError("There is no valid data to process in the Excel file.")

    return pd.DataFrame(valid_rows)


def build_item(row: pd.Series) -> Dict[str, Any]:
    item = {
        "Material": row["Material"],
        "Plant": row["Plant"],
        "StorageLocation": row["StorageLocation"],
        "GoodsMovementType": row["GoodsMovementType"],
        "GoodsMovementReasonCode": row["GoodsMovementReasonCode"],
        "QuantityInEntryUnit": str(row["QuantityInEntryUnit"]),
        "GdsMvtExtAmtInCoCodeCrcy": str(row["GdsMvtExtAmtInCoCodeCrcy"]),
    }

    # 只有在 Excel 中有值时才传 InventoryStockType
    if row.get("InventoryStockType"):
        item["InventoryStockType"] = row["InventoryStockType"]

    return item


def build_payload(chunk_df: pd.DataFrame) -> Dict[str, Any]:
    first = chunk_df.iloc[0]
    items = [build_item(row) for _, row in chunk_df.iterrows()]
    payload = {
        "DocumentDate": first["DocumentDate"],
        "PostingDate": first["PostingDate"],
        "CtrlPostgForExtWhseMgmtSyst": first.get("CtrlPostgForExtWhseMgmtSyst", "") or "2",
        "GoodsMovementCode": first.get("GoodsMovementCode", "") or "05",
        "ReferenceDocument": first["ReferenceDocument"],
        "to_MaterialDocumentItem": items,
    }
    if first.get("MaterialDocumentHeaderText"):
        payload["MaterialDocumentHeaderText"] = first["MaterialDocumentHeaderText"]
    return payload


def fetch_csrf_token(session: requests.Session) -> str:
    headers = {"x-csrf-token": "fetch", "Accept": "application/json"}
    resp = session.get(API_URL, headers=headers, auth=HTTPBasicAuth(USERNAME, PASSWORD), timeout=TIMEOUT)
    resp.raise_for_status()
    token = resp.headers.get("x-csrf-token")
    if not token:
        raise RuntimeError("Failed to retrieve CSRF token from the API.")
    return token


def post_with_retry(session: requests.Session, token: str, payload: Dict[str, Any]) -> requests.Response:
    headers = {
        "x-csrf-token": token,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    last_resp = None
    current_token = token
    for attempt in range(1, MAX_RETRY + 2):
        resp = session.post(API_URL, headers=headers, auth=HTTPBasicAuth(USERNAME, PASSWORD), json=payload, timeout=TIMEOUT)
        last_resp = resp
        if resp.status_code in (200, 201):
            return resp
        if resp.status_code == 403 and attempt <= MAX_RETRY:
            current_token = fetch_csrf_token(session)
            headers["x-csrf-token"] = current_token
            continue
    return last_resp


def save_results(base_dir: Path, summary: Dict[str, Any], success_docs: List[Dict[str, Any]], failed_docs: List[Dict[str, Any]]):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    json_file = base_dir / f"inventory_upload_result_{ts}.json"
    excel_file = base_dir / f"inventory_upload_result_{ts}.xlsx"
    full_result = {"summary": summary, "success_docs": success_docs, "failed_docs": failed_docs}
    json_file.write_text(json.dumps(full_result, ensure_ascii=False, indent=2), encoding="utf-8")
    with pd.ExcelWriter(excel_file, engine="openpyxl") as writer:
        pd.DataFrame(success_docs if success_docs else [{"message": "no success"}]).to_excel(writer, sheet_name="success", index=False)
        pd.DataFrame(failed_docs if failed_docs else [{"message": "no failure"}]).to_excel(writer, sheet_name="failed", index=False)
        pd.DataFrame([summary]).to_excel(writer, sheet_name="summary", index=False)
    return json_file, excel_file


def main(file_path=None, sheet_name=None, output_dir=None, output_json=None):
    """Run inventory upload. Supports both CLI args and function call."""
    print("=== SAP S/4HANA Public Cloud - Bulk Inventory Upload ===")

    if file_path is None:
        file_path = choose_file()
    else:
        file_path = Path(file_path)
    if not file_path.exists():
        raise FileNotFoundError(f"File does not exist: {file_path}")

    if sheet_name is None:
        sheet_name = DEFAULT_SHEET_NAME
    else:
        sheet_name = sheet_name.strip() or DEFAULT_SHEET_NAME

    if output_dir is None:
        output_dir = file_path.parent
    else:
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

    df = validate_and_prepare(file_path, sheet_name)
    total_rows = len(df)
    total_batches = math.ceil(total_rows / BATCH_SIZE)
    print(f"Validation passed. {total_rows} rows will be split into {total_batches} batches (batch size {BATCH_SIZE}).")

    session = requests.Session()
    token = fetch_csrf_token(session)
    print("CSRF token retrieved successfully.")

    success_docs = []
    failed_docs = []

    for batch_index in range(total_batches):
        start = batch_index * BATCH_SIZE
        end = min(start + BATCH_SIZE, total_rows)
        chunk_df = df.iloc[start:end].copy()
        excel_rows = chunk_df["__excel_row_no__"].tolist()
        payload = build_payload(chunk_df)
        print(f"Uploading batch {batch_index + 1}/{total_batches} with {len(chunk_df)} rows (Excel rows {excel_rows[0]}-{excel_rows[-1]})...")
        resp = post_with_retry(session, token, payload)

        if resp.status_code in (200, 201):
            try:
                data = resp.json()
            except Exception:
                data = {}
            body = data.get("d", data)
            doc_no = body.get("MaterialDocument", "")
            doc_year = body.get("MaterialDocumentYear", "")
            success_docs.append({
                "batch_no": batch_index + 1,
                "row_count": len(chunk_df),
                "excel_row_start": excel_rows[0],
                "excel_row_end": excel_rows[-1],
                "material_document": doc_no,
                "material_document_year": doc_year,
            })
            print(f"Batch {batch_index + 1} succeeded, material document: {doc_no} / {doc_year}")
        else:
            failed_docs.append({
                "batch_no": batch_index + 1,
                "row_count": len(chunk_df),
                "excel_row_start": excel_rows[0],
                "excel_row_end": excel_rows[-1],
                "status_code": resp.status_code,
                "response_text": resp.text,
                "payload": payload,
            })
            print(f"Batch {batch_index + 1} failed, HTTP {resp.status_code}")
            print(resp.text)

    summary = {
        "run_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "api_url": API_URL,
        "excel_file": str(file_path.resolve()),
        "sheet_name": sheet_name,
        "total_rows": total_rows,
        "batch_size": BATCH_SIZE,
        "total_batches": total_batches,
        "success_batches": len(success_docs),
        "failed_batches": len(failed_docs),
    }
    json_file, excel_file = save_results(output_dir, summary, success_docs, failed_docs)

    if output_json:
        result = {"summary": summary, "success": success_docs, "failed": failed_docs, "json_file": str(json_file), "excel_file": str(excel_file)}
        Path(output_json).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n=== Execution finished ===")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"Result JSON file: {json_file}")
    print(f"Result Excel file: {excel_file}")
    return summary


if __name__ == "__main__":
    import sys
    if len(sys.argv) >= 2:
        fpath = sys.argv[1]
        sname = sys.argv[2] if len(sys.argv) >= 3 else DEFAULT_SHEET_NAME
        odir = sys.argv[3] if len(sys.argv) >= 4 else None
        ojson = sys.argv[4] if len(sys.argv) >= 5 else None
        main(file_path=fpath, sheet_name=sname, output_dir=odir, output_json=ojson)
    else:
        main()