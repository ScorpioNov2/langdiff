# Langdiff — Advanced Bilingual & Code Diff Viewer

**Langdiff** is a high-performance, full-screen web application tailored for language learners and developers to read bilingual texts, review native Git patches, or resolve code conflicts side-by-side. 

Powered by a **dual-sided sliding-window virtualization engine** and dynamic DOM layout measurement, Langdiff effortlessly displays hundreds of thousands of lines without UI stuttering, horizontal alignment gaps, or layout skew—even under rapid fling-scrolling or complex IME text compositions like Vietnamese Telex.

---

## ⚡ Core Operational Modes

Langdiff features an Intelligent Auto-Detection system on the toolbar that instantly switches behavior based on your input:

### 1. 🌐 Bilingual Mode (Default)
Parses a single source document using simple prefix characters (`-` and `+`) to create a fluid, Git-like side-by-side reading layout optimized for language translation or quick text changes.

### 2. 🛠️ Native Patch / Diff Mode
Triggered automatically when standard Git metadata (e.g., `diff --git`, `@@ -a,b +c,d @@`) or a `.patch`/`.diff` file is loaded. 
* **True Line Numbering:** Extracts real hunk header ranges so line grids match your actual repository history instead of global file indices.
* **Ergonomic File Panel:** Accessible via the **Files** button or by pressing `f`. Includes real-time fuzzy text filtering, modification counters (`+N / -M`), an inline dismiss `×` button, and dynamic pinned headers. Selecting a collapsed file automatically expands it before targeting.
* **Code Folding:** Click a file name block or press `c` to instantly collapse or expand it. Center-aligned SVG arrows visually rotate to indicate open/closed status.
* **Granular Word Diff:** Groups paired deletion and insertion streams, cross-checking tokens with a ≥ 40% content similarity formula to inject bold, intra-line word-level highlights.

### 3. ⚖️ Compare Mode (`A === B`)
Triggered automatically when a document contains a three-equals-sign separator (`===`) or when selected via the toolbar.
* **True Dual-Pane Inputs:** Splits the input layout into two distinct, persistent buffer zones: **Text A (Original)** and **Text B (Modified)**, complete with fully synchronized dynamic line gutters.
* **Interactive Conflict Engine:** Flags distinct variations with custom `"Change N · −x +y"` headers. Features inline `Keep A` and `Take B` action controls that instantly dim and strikethrough rejected text structures.
* **Bulk Resolution:** Master ribbon containing `Take all B`, `Keep all A`, and `Reset` selectors, backed by a live counter.
* **Buffer Rewriting:** Clicking `Apply Merge` safely strips platform newline anomalies (`\r`), standardizes spacing, and synchronizes both raw inputs into matching unified buffers.
* **Instant Clipboard Export:** Quick `Copy Merged` action button immediately captures your finalized resolution data.

---

## 📝 Syntax & Formatting Rules (Bilingual Mode)

The rendering engine follows one strict rule: **Every row beginning with `+` or `-` has the prefix symbol AND exactly one following space stripped.** Indentation spaces after that first stripped space are preserved exactly.

### Prefix & Grid Coverage

| Prefix | Row Appearance | Ideal Use Case |
| :---: | | |
| **`- `** | Red Background | Original language / old code |
| **`+ `** | Green Background | Target language / updated code |
| *(2 spaces)* | Standard row | Context / shared description |

### ❌ Incorrect Formatting (Breaks Indentation)
Do not stick prefixes directly to text without a trailing space, and avoid uneven whitespace configurations:
```text
-def compute_total():
+def compute_total():
-    print("Old code")
+    print("New code")
```
* **Why it fails:** On line 4, the parser swallows the `+` and the *first* indentation space, leaving only 3 leading spaces in your rendering container. This completely breaks language runtime trees like Python!

### ✅ Correct Formatting Example
```text
  This is a standard row using 2 leading spaces.
- I am using the Langdiff application in Vietnamese.
+ I am using the Langdiff application in English.
```
* **Result:** The engine strips the `- ` and `+ ` prefix tokens, making both languages align flush against the edge while standard text blocks retain their exact positioning.

---

## 🎨 Modern Workspace UI & Logic

### 🎛️ Two-Tier Responsive Toolbar (`ld-controls`)
The header control layout is structured into two persistent vertical layers to handle extensive code stats without button overlapping:
* **Row 1 (Top Tier):** Anchors the brand logo on the far left and binds core action links (`Theme`, `Split View`, `Syntax`, `Find`, `Usage`, `Choose File`, `Toggle Input`, and `Render View`) flush against the right margin. `Render View` acts as a locked anchor at the extreme right.
* **Row 2 (Bottom Tier):** Extends across the full width. It positions dynamic metadata statistics (`Compare · A ... lines · B ... lines`) on the far left beneath the logo. Dropdown controls are locked to the right margin, placing the **Mode Selector** directly beneath the `Render View` button, and the **Language Selector** directly to its left.

### 🔍 IDE-Grade Search Panel (`Ctrl + F`)
Relocates CodeMirror's search interface to a modern, top-aligned, two-row overlay panel:
* **Row 1:** Groups `Find` input, navigation controls (`Next`/`Previous`), and `All` filters.
* **Row 2:** Houses `Replace` text inputs and execution controls.
* Replaces rigid checkboxes with sleek icon toggle micro-buttons for case matching (`Aa`), Regex (`.*`), and word boundaries (`ab`), styled dynamically to match dark/light canvases.

### 🧠 Trailing Whitespace Highlighting & Gutter Alignment
* **Active Line Protection:** Instantly disables aggressive red warning backgrounds on the current active cursor line, allowing clean real-time typing and fluid `Enter` line breaks without immediate error feedback.
* **Vertical Parity:** Code folding triggers and error markers are geometrically centered to guarantee vertical structural alignment with gutter line numbers.

### 🛎️ Accessible Pop-up Dialog Modals
Completely replaces standard browser alert/confirm prompts with customized accessible modal components. Supports instant `Esc` dismissal, interactive `Tab` choice toggles, automatic confirmation focus bounds, and precise post-dismissal cursor tracking.

### 🌑 Full-Page Dark Mode Integration
Propagates selected light/dark states across the entire system ecosystem including toolbars, select panels, search nodes, file utilities, layout rows, internal modal popups, and custom rounded scrollbars.

---

## 🎹 Navigation & Accessibility Hotkeys

*(Note: Hotkeys are active only when your input focus is not inside an active text field)*

* **`f`** : Toggle the floating Files Panel browser list.
* **`Esc`** : Instantly dismiss the Files Panel or Close Active Dialogs.
* **`j` / `k`** : Jump focus sequentially to the next / previous diff Hunk (displays an interior focus border).
* **`[` / `]`** : Jump focus sequentially to the next / previous File (automatically expands collapsed blocks and targets the new header).
* **`c`** : Fold or unfold the current file container block. (Clicking a file row also folds it).

---

## 🛠️ Step-by-Step Workspace Workflow

1. **Draft Document:** Create a native plain text file (`.txt`), standard Markdown document (`.md`), or standard patch file (`.patch`/`.diff`) locally.
2. **Organize Text:** Apply the standard prefix guidelines or generate files directly out of a Git workflow.
3. **Import to Langdiff:**
   * **Drag & Drop:** Drop your file from your desktop anywhere over the active web container layout.
   * **Manual Input:** Toggle the panel, fill out the Text A & B inputs, and click **Render View**. Empty inputs are rendered directly to allow workspace cleanups.
4. **Auto-Save Lifecycle:** Refresh or close tabs safely. All ongoing sessions are cached locally inside your browser's persistent `LocalStorage` container.
