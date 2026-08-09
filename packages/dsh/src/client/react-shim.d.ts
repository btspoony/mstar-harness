/**
 * Dev-time typing shim for the React surface the panel consumes: the classic
 * JSX runtime (`React.createElement`, `jsx: "react"`), the global JSX
 * namespace, `createElement` and CSS-module imports.
 *
 * The real `@types/react` arrives with the Task 4 client-bundle build (bun
 * build does not type-check; only the `tsc` declaration gate does) and this
 * package has no react dependency today, so the shim keeps the dev-time
 * `tsc --strict` gate self-contained and dependency-free. It mirrors only the
 * surface the panel actually uses — nothing more.
 *
 * simplify: hand-typed subset of @types/react + a css-module declaration.
 * Upgrade path (recorded in plan Task 4): add @types/react (and switch the
 * package tsconfig to `jsx: "react-jsx"`) when the client bundle build lands;
 * remove this shim.
 */

declare namespace JSX {
  interface Element {
    readonly $$typeof: symbol
    readonly props: unknown
  }
  interface IntrinsicElements {
    [elem: string]: Record<string, unknown> & { children?: unknown }
  }
}

declare module 'react' {
  export = React
  namespace React {
    type ReactNode =
      | string
      | number
      | boolean
      | null
      | undefined
      | readonly ReactNode[]
      | ReactElement
    interface ReactElement {
      readonly $$typeof: symbol
      readonly props: unknown
    }
    function createElement(
      type: unknown,
      props: unknown | null,
      ...children: readonly unknown[]
    ): ReactElement
    const Fragment: (props: { readonly children?: ReactNode }) => ReactElement
  }
}

/** CSS-module import shape (bun build rewrites it into a hashed class map). */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
