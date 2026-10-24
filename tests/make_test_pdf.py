#!/usr/bin/env python3
"""Write a small one-page PDF with extractable text (no dependencies).

Usage: make_test_pdf.py OUTPUT.pdf
"""
import sys

LINES = [
    "Test Paper for AI Chat",
    "Abstract. This document exists to test the Zotero AI Chat plugin.",
    "The secret marker is QUANTUM-BANANA-42.",
    "Self-attention lets the model weigh every token against every other token.",
    "Limitations: the evaluation uses a single synthetic document.",
]


def escape(text):
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def main():
    out = sys.argv[1]
    content = "BT /F1 12 Tf 72 720 Td 16 TL\n"
    content += "\n".join(f"({escape(line)}) Tj T*" for line in LINES)
    content += "\nET\n"
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        f"<< /Length {len(content.encode('latin-1'))} >>\nstream\n{content}endstream",
    ]
    pdf = b"%PDF-1.4\n"
    offsets = []
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf += f"{i} 0 obj\n{obj}\nendobj\n".encode("latin-1")
    xref = len(pdf)
    pdf += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        pdf += f"{off:010d} 00000 n \n".encode()
    pdf += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    with open(out, "wb") as f:
        f.write(pdf)


if __name__ == "__main__":
    main()
