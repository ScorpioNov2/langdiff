## Langdiff - Bilingual Markdown Viewer

Langdiff is a lightweight, full-screen web application tailored for language learners and developers to read bilingual texts or side-by-side code variations. By parsing a single document using simple prefixes (+ and -), it creates a clean, Git-inspired alignment interface without causing horizontal structural gaps or messy alignment mismatches.

------------------------------

## 📝 Syntax Rules
Langdiff analyzes text line-by-line based on the prefix character found at the absolute start of each line:

| Prefix | Row Appearance | Index Grid Coverage | Ideal Use Case |
|---|---|---|---|
| - | Red Row Background | Left Line Numbers Only | Original Language (e.g., Vietnamese) / Old Code |
| + | Green Row Background | Right Line Numbers Only | Target Language (e.g., English) / Updated Code |
| None | Standard White Row | Both Columns Line Numbers | Context Dividers / Shared Descriptive Explanations |

------------------------------

## 🚀 Usage & Formatting Guide
The custom rendering engine operates on a strict, predictable rule: Every row beginning with + or - will have the prefix symbol AND EXACTLY ONE white space immediately following it stripped away.

Any subsequent whitespace characters or indentation configurations located after that first stripped space are treated as intentional data and will be preserved exactly as written.

## 📐 Understanding the Alignment Mechanics
To guarantee your layout compiles cleanly and code blocks (like Python scripts) don't lose their logical indentation, look at how the calculation behaves:

## ❌ Incorrect Formatting (Misunderstanding the Strip Rule)
If you paste raw Git diffs where prefixes are directly stuck to the text without a following space, or if you write uneven spacing:

```text
-def compute_total():
+def compute_total():
-    print("Old code")
+    print("New code")
```

* Why this breaks:
   * On line 2, the row starts with +d. There is no space following the +. The engine removes +, leaving def compute_total(): with 0 leading spaces (Correct).
   * On line 4, the row starts with + followed by 4 indentation spaces. The engine catches the + and swallows the 1st space, leaving only 3 leading spaces on your screen. This completely breaks Python's syntax tree!

## ✅ Correct Formatting (Intentionally Planning for the Strip Rule)
To make your content match up beautifully, you must explicitly type exactly ONE single space directly behind every + or - symbol, followed by your actual content or normal code indentation.

```text
- def compute_total():
+ def compute_total():
-     print("Old code")
+     print("New code")
```

* Why this works flawlessly:
   * Line 2 (+ def...): The engine strips the + and the single trailing space (+ ). The remaining string is def compute_total(): $\rightarrow$ Rendered with 0 spaces of indentation.
   * Line 4 (+ print...): The row is written with a +, a single space, and then the 4-space code indent (totaling 5 spaces in your raw file). The engine strips the + and the 1st space (+ ). The remaining string is print("New code") $\rightarrow$ Rendered with exactly 4 spaces of indentation!

## 💡 General Text Rule (Language Learning)
The same logic applies to text paragraphs. Always put exactly one space after the symbol so your sentences sit flush against the margin:

```
- Tôi đang sử dụng ứng dụng Langdiff.
+ I am using the Langdiff application.
```

* Result: The engine strips - and + , making both languages align straight against the edge.

------------------------------

## 🛠️ Step-by-Step User Workflow

   1. Draft your Document: Create a native plain text file (.txt) or standard Markdown document (.md) on your local machine.
   2. Organize Content: Place your target translation strings or code modifications directly underneath their respective reference sentences using the exact + and - rules outlined above.
   3. Import to Langdiff:
      * Drag & Drop: Pick up your file from your desktop and drag it anywhere over the active web container layout.
      * Manual Paste: Click "Toggle Input" on the top bar, paste your raw text into the box, and click "Render View".
   4. Auto-Save Lifecycle: You can close the browser tab or refresh safely. Your active workspace stays cached inside the browser's native LocalStorage.
