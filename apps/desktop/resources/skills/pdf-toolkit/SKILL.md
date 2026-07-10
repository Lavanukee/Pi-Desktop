---
name: pdf-toolkit
description: Read, extract, split, merge, and fill PDF files with open-source Python libraries. Use when the user wants to pull text or tables out of a PDF, combine or split documents, extract pages or images, read form fields, or OCR a scanned PDF. A permissive (MIT) alternative to proprietary PDF skills.
license: MIT (© 2026 Pi Desktop contributors)
---

# PDF toolkit

Work with PDFs using well-maintained open-source Python libraries. Pick the tool by
task; verify output on a couple of pages before processing a whole document.

Libraries: `pypdf` (structure: merge/split/rotate/metadata/forms), `pdfplumber`
(precise text + tables + coordinates), `pymupdf`/`fitz` (fast text, images, render),
and `pytesseract` + `pdf2image` (OCR for scans). Install what you use.

## Extract text

```python
import pdfplumber
with pdfplumber.open(path) as pdf:
    text = "\n".join(p.extract_text() or "" for p in pdf.pages)
```

If `extract_text()` returns little/nothing, the PDF is likely **scanned** → OCR path.

## Extract tables

```python
with pdfplumber.open(path) as pdf:
    tables = [t for p in pdf.pages for t in p.extract_tables()]
```

Inspect the raw grid before trusting it; tune `table_settings` (line vs. text
strategy) for tricky layouts. Convert to a DataFrame for cleanup.

## Merge / split / extract pages

```python
from pypdf import PdfReader, PdfWriter
# merge
w = PdfWriter()
for f in files:
    w.append(f)
w.write("merged.pdf")
# split page range 2..5 (0-indexed)
r = PdfReader(path); w = PdfWriter()
for i in range(1, 5): w.add_page(r.pages[i])
w.write("pages_2-5.pdf")
```

## Forms & metadata

- Read fields: `PdfReader(path).get_fields()`.
- Fill: `writer.update_page_form_field_values(page, {"Name": "..."})`.
- Metadata: `reader.metadata`; set via `writer.add_metadata({...})`.

## OCR a scanned PDF

```python
from pdf2image import convert_from_path
import pytesseract
pages = convert_from_path(path, dpi=300)
text = "\n".join(pytesseract.image_to_string(img) for img in pages)
```

Needs the system `tesseract` + `poppler` installed. Higher DPI = better accuracy,
slower. Spot-check OCR output — it is never perfect.

## Guardrails

- Encrypted PDFs need the password (`reader.decrypt(pw)`); don't attempt to bypass.
- Extraction preserves reading-order imperfectly for multi-column pages — verify.
- For large batches, process page-by-page to bound memory.
