/**
 * A side-effect stylesheet import (`import "./shell.css"`) contributes rules, not
 * values, so the module has no exports to type. `Bun.build` still picks it up and
 * emits it into the bundle's single CSS asset.
 */
declare module "*.css" {}
