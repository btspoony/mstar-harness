/**
 * The feature tabs inside a record: a project's Roadmap / Issues / Iterations.
 *
 * A tab strip, not a second navigation: the destinations stay in `Nav`, and this
 * only switches the sections of the record the reader already opened. The panel
 * is the caller's; this component owns the strip and the selected state.
 */

export type TabItem = {
  /** Stable feature id; the caller maps it to its panel. */
  id: string;
  /** Localized label. */
  label: string;
  /** Optional count rendered after the label. */
  count?: number;
};

export type TabsProps = {
  tabs: readonly TabItem[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Accessible name for the strip. */
  label: string;
};

export function Tabs(props: TabsProps) {
  return (
    <div className="seg" role="tablist" aria-label={props.label}>
      {props.tabs.map((tab) => {
        const active = tab.id === props.activeId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`ms-tab-${tab.id}`}
            aria-selected={active}
            aria-controls={`ms-tabpanel-${tab.id}`}
            className="nav-btn"
            data-ms-tab={tab.id}
            onClick={() => props.onSelect(tab.id)}
          >
            {tab.label}
            {tab.count === undefined ? null : <span className="num">{tab.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
