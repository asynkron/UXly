<img src="assets/images/header.png" width="100%" alt="UXly — UI Consistency Inspector" />

# UXly — UI Consistency Inspector

A Chrome extension that inspects web pages for UI consistency issues. UXly scans live DOM elements, computed styles, CSS variables, and layout geometry to surface visual defects that are hard to catch by eye. Designed for designers, developers, and AI agents verifying UI coherence.

## Installation

1. Clone this repo
2. Open `chrome://extensions/` and enable **Developer mode**
3. Click **Load unpacked** and select the `uxly` directory
4. Click the UXly icon or open the side panel to analyze any page

## Feature Groups

### Color & Palette

Detects color system issues across CSS variables and computed styles.

| Check | Severity | Description |
|---|---|---|
| `near-miss-color` | error | Two colors differ by < 5% — likely an unintentional mismatch |
| `similar-color` | warn | Two colors are very close but not identical within a component group |
| `too-many-colors` | warn | A style property (e.g. `backgroundColor`) has too many distinct values across a component type |
| `color-sprawl` | warn | The page uses an excessive number of distinct colors overall |
| `palette-detected` | info | Reports the detected color palette, source (CSS vars or DOM), and best-matching color wheel strategy |
| `palette-harmony` | warn | Palette colors are poorly aligned to any standard color harmony (analogous, complementary, triadic, etc.) |
| `palette-suggestion` | warn/info | Suggests adjusted hex values to better align colors to the detected strategy |
| `palette-shades` | info | Generated Tailwind-scale shade ramps (50–950) for each palette color |

### Surface & Background Layers

Analyzes CSS custom properties for background/surface tokens (`--bg-*`, `--surface-*`, `--paper`, `--canvas`, `--muted`, `--card`, `--elevated`, `--layer-*`, etc.) and checks lightness progression.

| Check | Severity | Description |
|---|---|---|
| `surface-layers` | info | Lists all detected surface/bg tokens sorted by actual OKLCH lightness |
| `surface-step-consistency` | warn | Lightness gaps between consecutive layers are uneven — creates an unpredictable elevation system |
| `surface-suggestion` | info | Suggests evenly-spaced lightness values across the detected range |
| `surface-hue-drift` | warn | Surface layers shift in hue — e.g. some are warm, others are cool-tinted |

### Contrast & Accessibility

WCAG 2.1 AA compliance checks with palette-aware fix suggestions.

| Check | Severity | Description |
|---|---|---|
| `low-contrast` | error | Text fails WCAG AA contrast ratio (4.5:1 for normal text, 3:1 for large text). Suggests specific palette shades that pass |
| `missing-label` | error | Form input (`<input>`, `<select>`, `<textarea>`) has no accessible label (no `<label>`, `aria-label`, `aria-labelledby`, or `title`) |
| `tiny-tap-target` | warn | Interactive element is smaller than 44×44px minimum touch target |
| `crowded-tap-targets` | info | Adjacent interactive elements are less than 8px apart |

### Typography

Detects inconsistencies and readability issues in text rendering.

| Check | Severity | Description |
|---|---|---|
| `heading-inconsistency` | error | Heading levels (h1–h6) break size hierarchy — e.g. an h3 is larger than an h2 |
| `mixed-fonts` | warn | Multiple font families are used where consistency is expected |
| `cramped-text` | warn | Text elements with `line-height` below 1.25× the font size |
| `tight-line-height` | warn | Multi-line text blocks with line-height < 1.2 |
| `line-too-long` | info | Text lines exceed ~75 characters — hurts readability |

### Layout & Spacing

Checks spatial relationships between sibling elements, sections, and panels.

| Check | Severity | Description |
|---|---|---|
| `misaligned-siblings` | warn | Sibling elements have top or left edges 1–3px off from each other |
| `inconsistent-gap` | warn | Repeated same-tag children have uneven spacing between them |
| `inconsistent-section-spacing` | warn | Vertical gaps between landmark sections (header, main, footer, nav, aside) deviate > 50% from the median |
| `inconsistent-padding` | warn | A component type has too many distinct padding values |
| `cramped-padding` | warn | Container elements with very tight padding (< 6px) around non-interactive content |

### Component Consistency

Flags visual sprawl across repeated component types.

| Check | Severity | Description |
|---|---|---|
| `too-many-sizes` | warn/error | A component type (button, input, etc.) has more size variants than expected |
| `too-many-weights` | warn | A component type uses too many distinct font weights |
| `inconsistent-rounding` | warn | Border radius values vary unexpectedly within a component type |
| `outlier` | warn/info | A single element deviates significantly from its peers in a style property |
| `border-radius-sprawl` | warn | Too many distinct border-radius values used across the page |
| `rounded-panel-overuse` | info | Rounded borders appear on most panel-like elements — may indicate overuse |

### Icons

Checks icon sizing and alignment within interactive elements.

| Check | Severity | Description |
|---|---|---|
| `inconsistent-icon-size` | warn | Icons (SVG/img) inside buttons, links, or flex containers vary in size by more than 2px |
| `misaligned-icon` | warn | Icon vertical center is offset from adjacent text center within the same parent |

### Overflow & Clipping

Detects content that is cut off or scrolling unexpectedly.

| Check | Severity | Description |
|---|---|---|
| `text-clipped` | warn | Element has `overflow: hidden` and content is wider/taller than the box — text is silently clipped |
| `text-truncated` | info | Element uses `text-overflow: ellipsis` — intentional but worth flagging |
| `nested-scroll` | warn | A scrollable container is nested inside another scrollable container |

### Z-Index & Layering

Detects stacking context issues.

| Check | Severity | Description |
|---|---|---|
| `blocked-interactive` | error | An interactive element (button, link, input) is fully covered by a higher-z non-interactive element |
| `excessive-z-index` | info | Non-interactive element uses `z-index` > 100 |

### Panels & Containers

Checks structural container relationships.

| Check | Severity | Description |
|---|---|---|
| `nested-panel` | warn | Panel-like elements (with borders or shadows) are nested inside each other |
| `adjacent-panels` | warn | Bordered/shadowed sibling panels have very small gaps (< 4px) between them |

## Output

UXly produces a JSON result with:

- **`score`** — 0–100 overall UI consistency score
- **`findings`** — array of `{ severity, category, message }` objects
- **`analyses`** — raw data from each analysis pass (consistency, contrast, palette, tap targets, etc.)

Results are available via the side panel UI or programmatically through `window.uxlyResult` when the script is injected directly.

## License

MIT
