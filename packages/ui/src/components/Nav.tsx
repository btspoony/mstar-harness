/**
 * The five destinations, in one horizontal row.
 *
 * The dashboard's navigation is the product's navigation (compass D22), so this
 * is the only destination component and both hosts mount it. It owns no routing:
 * `onSelect` hands the id back and the host adapter decides what that means.
 *
 * The active destination is marked by `aria-current="page"` AND an underline, so
 * the state survives forced colors where the accent colour does not.
 */

export type NavItem = {
  /** Stable destination id; the caller maps it to its own route. */
  id: string;
  /** Localized label. */
  label: string;
};

export type NavProps = {
  items: readonly NavItem[];
  /** The active destination id, or `null` when none is (a detail view). */
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Accessible name for the navigation landmark. */
  label: string;
};

export function Nav(props: NavProps) {
  return (
    <nav className="app-nav" aria-label={props.label}>
      {props.items.map((item) => {
        const active = item.id === props.activeId;
        return (
          <button
            key={item.id}
            type="button"
            className="nav-btn"
            aria-current={active ? "page" : undefined}
            data-ms-nav-item={item.id}
            onClick={() => props.onSelect(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
