// Customization sidebar. Mirrors the original BuddyRevival wardrobe panel (web/src/ui/wardrobe-panel.js):
// one row per visible wardrobe option, one picker per selector showing the current choice, a choice grid
// for the open picker. Every choice goes through the original Wardrobe via CharacterController.
import { useState, useSyncExternalStore } from 'react';
import type { Selector, WardrobeOption } from '@original/domain/wardrobe.js';
import type { CharacterController, Icons } from '../character/controller';

/** Icon frame size used by the original artwork (registration point at the centre). */
const ICON_SIZE = 36;

const hex = (color: number) => `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
/** Same naming as the original panel's accessible labels. */
const readableName = (icon: string) => icon.replace(/^(Icon|Char)_/, '').replace(/_/g, ' ');
const KIND_LABEL = { color: 'colour', texture: 'style', itemGroup: 'item' } as const;

function Thumbnail({ icons, name }: { icons: Icons; name: string }) {
  const icon = icons[name];
  return (
    <span className="icon" aria-hidden="true">
      {icon && <img src={icon.url} alt="" style={{ left: ICON_SIZE / 2 + icon.x, top: ICON_SIZE / 2 + icon.y }} draggable={false} />}
    </span>
  );
}

function Swatch({ selector, index, icons }: { selector: Selector; index: number; icons: Icons }) {
  if (selector.kind === 'color') return <span className="swatch" style={{ background: hex(selector.colors[index]) }} aria-hidden="true" />;
  return <Thumbnail icons={icons} name={selector.icons[index]} />;
}

const choiceLabel = (selector: Selector, index: number) =>
  selector.kind === 'color' ? hex(selector.colors[index]) : readableName(selector.icons[index]);

/** "Hair Color colour 1", "Hair Color style", ... (numbered only when a kind repeats in a row). */
function selectorLabels(option: WardrobeOption) {
  const counts: Record<string, number> = {};
  for (const s of option.selectors) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  const seen: Record<string, number> = {};
  return option.selectors.map(s => {
    seen[s.kind] = (seen[s.kind] ?? 0) + 1;
    return `${option.name} ${KIND_LABEL[s.kind]}${counts[s.kind] > 1 ? ` ${seen[s.kind]}` : ''}`;
  });
}

function Choices({ selector, label, icons, onChoose }: { selector: Selector; label: string; icons: Icons; onChoose: (index: number) => void }) {
  const current = selector.get();
  const values = selector.kind === 'color' ? selector.colors : selector.icons;
  return (
    <div className={`choices ${selector.kind === 'color' ? 'colors' : 'tiles'}`} role="listbox" aria-label={label} data-selector={selector.id}>
      {values.map((_, index) => (
        <button
          key={index}
          type="button"
          role="option"
          aria-selected={index === current}
          title={choiceLabel(selector, index)}
          aria-label={choiceLabel(selector, index)}
          onClick={() => onChoose(index)}
        >
          <Swatch selector={selector} index={index} icons={icons} />
        </button>
      ))}
    </div>
  );
}

export function CustomizePanel({ controller }: { controller: CharacterController }) {
  // Re-render after every applied change (the original catalog XML is the state).
  useSyncExternalStore(
    listener => controller.subscribe(listener),
    () => controller.version,
  );
  const [open, setOpen] = useState<string | null>(null);
  const options = controller.visibleOptions();
  const icons = controller.icons;

  return (
    <section className="customize" aria-label="Customize">
      <header className="panel-head">
        <h2>Customize</h2>
        <span className="muted-inline">{options.length} categories</span>
      </header>
      <ul className="options">
        {options.map(option => {
          const labels = selectorLabels(option);
          const openIndex = option.selectors.findIndex(s => s.id === open);
          const isDefault = controller.isDefault(option);
          return (
            <li key={option.name} className="option" data-option={option.name}>
              <div className="option-row">
                <span className="option-name">{option.name}</span>
                <span className="pickers">
                  {option.selectors.map((selector, k) => (
                    <button
                      key={selector.id}
                      type="button"
                      className="picker"
                      aria-label={labels[k]}
                      aria-expanded={open === selector.id}
                      title={`${labels[k]}: ${choiceLabel(selector, selector.get())}`}
                      data-selector={selector.id}
                      onClick={() => setOpen(open === selector.id ? null : selector.id)}
                    >
                      <Swatch selector={selector} index={selector.get()} icons={icons} />
                    </button>
                  ))}
                </span>
                <button
                  type="button"
                  className="reset"
                  disabled={isDefault}
                  aria-label={`Reset ${option.name}`}
                  title={isDefault ? 'Default' : `Reset ${option.name} to default`}
                  onClick={() => controller.resetOption(option.name)}
                >
                  Reset
                </button>
              </div>
              {openIndex >= 0 && (
                <Choices
                  selector={option.selectors[openIndex]}
                  label={labels[openIndex]}
                  icons={icons}
                  onChoose={index => controller.choose(option.selectors[openIndex].id, index)}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
