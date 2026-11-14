# Langdiff — Advanced Bilingual & Code Diff Viewer

**Langdiff** is a high-performance, full-screen web application tailored for language learners and developers to read bilingual texts, review native Git patches, or resolve code conflicts side-by-side. 

Powered by a **dual-sided sliding-window virtualization engine** and dynamic DOM layout measurement, Langdiff effortlessly displays hundreds of thousands of lines without UI stuttering, horizontal alignment gaps, or layout skew—even under rapid fling-scrolling or complex IME text compositions like Vietnamese Telex.

---

## ⚡ Core Operational Modes

Langdiff features an Intelligent Auto-Detection system on the toolbar that instantly switches behavior based on your input:

### 1. 🌐 Bilingual Mode (Default)
Parses a single source document using simple prefix characters (`-` and `+`) to create a fluid, Git-like side-by-side reading layout optimized for language translation or quick text changes.

### 2. 🛠️ Native Patch / Diff Mode
Triggered automatically when standard Git metadata (e.g., `diff --git`, `@@ -a,b +c,d @@`) is detected. 
* **True Line Numbering:** Extracts real hunk header ranges so line grids match your actual repository history instead of global file indices.
* **Ergonomic File Panel:** Accessible via the **Files** button or by pressing `f`. Includes real-time fuzzy text filtering, modification counters (`+N / -M`), and dynamic pinned headers displaying file states (Added, Deleted, Modified, Renamed).
* **Code Folding:** Click a file name block or press `c` to instantly collapse or expand it.
* **Granular Word Diff:** Groups paired deletion and insertion streams, cross-checking tokens with a ≥ 40% content similarity formula to inject bold, intra-line word-level highlights.

### 3. ⚖️ Compare Mode (`A === B`)
Triggered automatically when a document contains a three-equals-sign separator (`===`) or when selected via the toolbar.
* **True Dual-Pane Inputs:** Splits the input layout into two distinct, persistent buffer zones: **Text A (Original)** and **Text B (Modified)**, complete with fully synchronized dynamic line gutters.
* **Interactive Conflict Engine:** Flags distinct variations with custom `"Change N · −x +y"` headers. Features inline `Keep A` and `Take B` action controls that instantly dim and strikethrough rejected text structures.
* **Bulk Resolution:** Master ribbon containing `Take all B`, `Keep all A`, and `Reset` selectors, backed by a live counter.
* **Buffer Rewriting:** Clicking `Apply Merge` safely strips platform newline anomalies (`\r`), standardizes spacing, and synchronizes both raw inputs into matching unified buffers.
* **Instant Clipboard Export:** Quick `Copy Merged` action button immediately captures your finalized resolution data.

---

## 📝 Bilingual Mode Syntax Rules

Text is processed line-by-line using prefix markers placed at the absolute start of each row:

| Prefix | Row Appearance | Index Grid Coverage | Ideal Use Case |
| :---: | | | |
| **`-`** | Red Row Background | Left Line Numbers Only | Original Language (e.g., Vietnamese) / Old Code |
| **`+`** | Green Row Background | Right Line Numbers Only | Target Language (e.g., English) / Updated Code |
| *None* | Standard White Row | Both Columns Line Numbers | Context Dividers / Shared Descriptive Explanations |

---

## 🚀 Usage & Formatting Guide (Bilingual Mode)

The layout rendering core follows a strict parsing rule: **Every row starting with `+` or `-` will have the prefix character AND EXACTLY ONE trailing white space stripped away.** Any subsequent whitespaces or tab indentations are fully preserved as intentional syntax formatting.

### ❌ Incorrect Formatting (Breaks Indentation)
Do not stick prefixes directly to text without a trailing space, and avoid uneven whitespace configurations:
```text
-def compute_total():
+def compute_total():
-    print("Old code")
+    print("New code")
```
* **Why it fails:** On line 4, the parser swallows the `+` and the *first* indentation space, leaving only 3 leading spaces in your rendering container. This completely breaks language runtime trees like Python!

### ✅ Correct Formatting (Preserves Indentation)
Explicitly type exactly **ONE** single space directly behind every `+` or `-` symbol before writing your normal code/text indentation:
```text
- def compute_total():
+ def compute_total():
-     print("Old code")
+     print("New code")
```
* **Why it works flawlessly:** On line 4, the parser strips the `+` and the single trailing space (`+ `). The remaining string retains exactly 4 spaces of indentation, rendering perfectly on screen.

---

## 🎹 Navigation & Accessibility Hotkeys

* **`f`** : Toggle the floating Files Panel browser.
* **`Esc`** : Instantly dismiss the Files Panel.
* **`j` / `k`** : Jump focus sequentially between diff Hunks (displays a persistent high-contrast focus border).
* **`[` / `]`** : Jump focus sequentially between files (automatically expands collapsed blocks and targets the new header).
* **`c`** : Collapse or expand the currently focused file container block.

---

## 🛠️ Step-by-Step Workspace Workflow

1. **Draft Document:** Create a native plain text file (`.txt`), standard Markdown document (`.md`), or standard patch file (`.patch`/`.diff`) locally.
2. **Organize Text:** Apply the standard prefix guidelines or dập files directly out of a Git workflow.
3. **Import to Langdiff:**
   * **Drag & Drop:** Drop your file anywhere over the active web container layout.
   * **Manual Input:** Toggle the panel, fill out the Text A & B inputs, and click **Render View**.
4. **Auto-Save Lifecycle:** Refresh or close tabs safely. All ongoing sessions are cached locally inside your browser's persistent `LocalStorage` container.
