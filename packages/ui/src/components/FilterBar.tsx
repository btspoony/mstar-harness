/**
 * The filter row: fields, the applied chips, and the clear affordance.
 *
 * State is the caller's — this renders `filters` and reports changes, because
 * the address bar is the host adapter's (the dashboard keeps the query string in
 * the URL; the dsh pane keeps it in its own state). What the component owns is
 * the shape: fields wrap instead of shrinking, an applied filter is a chip the
 * reader can remove one at a time, and "clear" is disabled while nothing is
 * applied so it never lies about being useful.
 */
import type { ReactNode } from "react";


export type FilterOption = { value: string; label: string };

export type FilterField = {
  /** The filter's own key in the caller's filter object. */
  key: string;
  /** Localized field label. */
  label: string;
  value: string;
  options: readonly FilterOption[];
};

export type AppliedFilter = {
  key: string;
  /** The chip's own text: `severity: high`. */
  text: string;
};

export type FilterBarProps = {
  fields: readonly FilterField[];
  onFieldChange: (key: string, value: string) => void;
  /** The free-text search box, when the screen has one. */
  search?: { value: string; placeholder: string; onChange: (value: string) => void };
  applied: readonly AppliedFilter[];
  onClearFilter: (key: string) => void;
  onClearAll: () => void;
  clearLabel: string;
  /** Result count line, e.g. `26 results`. */
  resultSummary: ReactNode;
};

export function FilterBar(props: FilterBarProps) {
  const nothingApplied = props.applied.length === 0;
  return (
    <div className="filters">
        {props.fields.map((field) => (
          <label key={field.key} className="filter-field">
            <span>{field.label}</span>
            <select
              className="ctl"
              value={field.value}
              data-ms-filter={field.key}
              onChange={(event) => props.onFieldChange(field.key, event.target.value)}
            >
              {field.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ))}
        {props.search === undefined ? null : (
          // A `label`, as the prototype has it: clicking the magnifier's row focuses the
          // field, which a `span` cannot do. The input keeps its own aria-label so the
          // accessible name does not depend on the placeholder.
          <label className="search">
            <input
              type="search"
              value={props.search.value}
              placeholder={props.search.placeholder}
              aria-label={props.search.placeholder}
              onChange={(event) => props.search?.onChange(event.target.value)}
            />
          </label>
        )}
        <button type="button" className="btn" disabled={nothingApplied} onClick={props.onClearAll}>
          {props.clearLabel}
        </button>
        <span className="filters-meta">{props.resultSummary}</span>
      {nothingApplied ? null : (
        <div className="chips" data-ms-applied-filters="">
          {props.applied.map((chip) => (
            <span key={chip.key} className="chip">
              {chip.text}
              <button
                type="button"
                className="chip-x"
                aria-label={chip.text}
                onClick={() => props.onClearFilter(chip.key)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
