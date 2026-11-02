/**
 * `ui-mstar-linear-settings` locale namespace: the Linear OAuth card's copy.
 *
 * The namespace is the plugin's own (not `mstar-panel`): the card is a host
 * Settings surface with its own lifecycle, and a later host default must not
 * inherit panel chrome. zh and en are registered together by the plugin entry,
 * exactly like the panel dictionaries beside this file.
 */

import type { LocaleDictOf } from '@deepseek-ai/dsh-client-ui-slots'

/** Locale namespace id for the Linear Settings card. */
export const NS = 'ui-mstar-linear-settings'

/** Every string the card renders (no product copy outside this file). */
export type LinearSettingsKey =
  | 'state.loading'
  | 'state.unavailable'
  | 'state.disabled.title'
  | 'state.disabled.body'
  | 'state.unauthorized.title'
  | 'state.absent.body'
  | 'state.unreadable.body'
  | 'state.expired.body'
  | 'state.expired.summary'
  | 'state.authorized.title'
  | 'state.authorizing.title'
  | 'state.authorizing.body'
  | 'state.recovery.title'
  | 'state.recovery.body'
  | 'scope.label'
  | 'scope.unknown'
  | 'expiry.label'
  | 'expiry.unknown'
  | 'action.authorize'
  | 'action.cancel'
  | 'outcome.attempt-active'
  | 'outcome.denied'
  | 'outcome.timeout'
  | 'outcome.cancelled'
  | 'outcome.not-found'
  | 'outcome.unavailable'
  | 'note.no-secret'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'ui-mstar-linear-settings': LinearSettingsKey
  }
}

/** zh dictionary (repo bilingual convention; zh is the stub fallback locale). */
export const zh: LocaleDictOf<'ui-mstar-linear-settings'> = {
  'state.loading': '正在读取 Linear 凭据状态…',
  'state.unavailable': '无法读取 Linear 凭据状态（{reason}）。',
  'state.disabled.title': '该行未启用',
  'state.disabled.body': '请先在宿主的行开关中启用 linear-mcp。启用之前，这里不会出现授权动作。',
  'state.unauthorized.title': '未授权',
  'state.absent.body': '连接 Linear 需要一次显式授权。点击 Authorize 会在当前浏览器打开 Linear 授权页；不会自动同意授权。',
  'state.unreadable.body': '已保存的凭据无法读取。重新授权会替换它。',
  'state.expired.body': '访问令牌已于 {expiry} 过期。宿主会在下次使用时尝试刷新；保存了 refresh token 并不保证刷新必定成功。',
  'state.expired.summary': '访问令牌已过期',
  'state.authorized.title': '已授权',
  'state.authorizing.title': '授权中',
  'state.authorizing.body': '已在当前浏览器打开 Linear 授权页，等待你完成 consent。授权尝试与 PKCE verifier 由宿主持有；此卡片不保存任何秘密。等待可取消。',
  'state.recovery.title': '请在 host 本机完成授权',
  'state.recovery.body': '当前浏览器不在 host 机器上，回环回调无法返回。请改在 host 本机浏览器中完成授权，或在 host 终端运行 mstar linear auth。凭据是 host 级状态，授权一次全局有效。',
  'scope.label': '授权范围',
  'scope.unknown': '未知',
  'expiry.label': '访问令牌到期',
  'expiry.unknown': '未知',
  'action.authorize': 'Authorize',
  'action.cancel': '取消本次授权',
  'outcome.attempt-active': '此 host 上已有一次授权正在进行。请在已打开的浏览器中完成它，或先取消再开始新的授权。',
  'outcome.denied': '授权未完成（{reason}）。',
  'outcome.timeout': '未收到授权回调。若当前浏览器不在 host 机器上，回环回调无法返回——请改在 host 本机授权，或在 host 终端运行 mstar linear auth。',
  'outcome.cancelled': '已取消本次授权，可以重新开始。',
  'outcome.not-found': '此授权尝试已不在 host 上，请重新开始。',
  'outcome.unavailable': '无法开始授权（{reason}）。',
  'note.no-secret': '此卡片不读取、也不显示 access token、refresh token 或 PKCE verifier。',
}

/** en dictionary (the host's fallback locale). */
export const en: LocaleDictOf<'ui-mstar-linear-settings'> = {
  'state.loading': 'Reading the Linear credential state…',
  'state.unavailable': 'The Linear credential state could not be read ({reason}).',
  'state.disabled.title': 'Row disabled',
  'state.disabled.body': 'Enable the linear-mcp row with the host’s own toggle first. Until then this card offers no authorization action.',
  'state.unauthorized.title': 'Not authorized',
  'state.absent.body': 'Connecting Linear needs one explicit authorization. Authorize opens Linear’s consent page in this browser; there is no automatic consent.',
  'state.unreadable.body': 'The stored credential cannot be read. Authorizing again replaces it.',
  'state.expired.body': 'The access token expired at {expiry}. The host attempts a refresh on the next use; a saved refresh token is not a guarantee that it succeeds.',
  'state.expired.summary': 'Access token expired',
  'state.authorized.title': 'Authorized',
  'state.authorizing.title': 'Authorizing',
  'state.authorizing.body': 'Linear’s consent page is open in this browser; waiting for you to finish it. The host holds the authorization attempt and the PKCE verifier — this card stores no secret. You can cancel.',
  'state.recovery.title': 'Authorize on the host machine',
  'state.recovery.body': 'This browser is not on the host machine, so the loopback callback cannot return. Authorize from a browser on the host machine, or run mstar linear auth in the host terminal. The credential is host-level: one authorization covers the host.',
  'scope.label': 'Scope',
  'scope.unknown': 'unknown',
  'expiry.label': 'Access token expiry',
  'expiry.unknown': 'unknown',
  'action.authorize': 'Authorize',
  'action.cancel': 'Cancel this authorization',
  'outcome.attempt-active': 'An authorization is already in progress on this host. Finish it in the browser that opened, or cancel it before starting another.',
  'outcome.denied': 'Authorization did not complete ({reason}).',
  'outcome.timeout': 'No authorization callback arrived. If this browser is not on the host machine, the loopback callback cannot return — authorize from a browser on the host, or run mstar linear auth in the host terminal.',
  'outcome.cancelled': 'Authorization cancelled. You can start again.',
  'outcome.not-found': 'This authorization attempt is no longer on the host. Start again.',
  'outcome.unavailable': 'Authorization could not start ({reason}).',
  'note.no-secret': 'This card never reads or displays the access token, refresh token, or PKCE verifier.',
}
