# app-kit

Login y notificaciones push compartidos entre apps Capacitor + Supabase.

Cada app sigue siendo única: colores, textos, fotos y pantallas van en la app.
El kit solo pone la mecánica.

## Instalar

Desde GitHub, con la versión fija (el repo incluye `dist/`, no se compila al instalar):

```sh
npm install --save-exact "git+https://github.com/jesusvaros/app-kit.git#v0.3.0"
```

## Qué hay

### `@jesusvaros/app-kit/auth`
- `createNativeSignIn(config)`: hoja nativa de Google (Android e iOS) y de
  Apple (iOS). Devuelve `idToken` + `rawNonce`. Incluye lo aprendido en
  producción: tiempo máximo del logout previo, aviso si la hoja de Android no
  aparece (`SHEET_TIMEOUT`) y el nombre de Apple, que solo llega la primera vez.
- `SignInError` con códigos `CANCELLED | SHEET_TIMEOUT | NO_TOKEN | NOT_CONFIGURED | FAILED`.
- `createNonce()`: SHA-256 al proveedor, el original al backend.

### `@jesusvaros/app-kit/auth/supabase`
- `createSupabaseAuth({ supabase, url, publishableKey, native, appCallbackUrl, openInAppBrowser })`
  - `availableProviders()`: lo activado en Supabase que además funciona en este dispositivo.
  - `signIn(provider, { returnPath, beforeRedirect })`: hoja nativa →
    `signInWithIdToken`; si no hay hoja o falla (salvo cancelar), navegador.
    Devuelve `'signed-in' | 'redirecting' | 'cancelled'`.
  - `handleCallbackUrl(url)`: el enlace de vuelta del navegador en la app (PKCE o implícito, recuperación y errores).

### `@jesusvaros/app-kit/push`
Capa fina sobre `@capacitor/push-notifications` (dependencia opcional, se
importa solo en el móvil). En la web y sin el plugin todo es un no-op seguro.

- `createPush({ registerOn, channels, registerTimeoutMs, tokenStorageKey, storage })`
  - `getPermissionState()`: `'granted' | 'denied' | 'prompt' | 'unavailable'`.
  - `requestPermissionWhenUseful()`: abre el diálogo del sistema solo si la
    respuesta sigue abierta (`prompt`). En Android 13+ es el permiso
    `POST_NOTIFICATIONS`. **Nunca al abrir la app**: la app decide el momento.
  - `register()`: crea los canales de Android y resuelve con el token (o
    `PushError` `UNAVAILABLE | NOT_GRANTED | TIMEOUT | FAILED`).
    `registerOn: ['android']` deja iOS apagado mientras no haya APNs.
  - `onToken(({ token, previous }) => …)`: token nuevo, también cuando FCM lo
    renueva (con el anterior, para mover la fila).
  - `onRegistrationError`, `onReceived` (con la app abierta el sistema no
    enseña nada: pon tu aviso), `onTapped((message, actionId) => …)`. Cada uno
    devuelve la función para quitarlo. `message.data` siempre es un objeto.
  - `listen()`: engancha los listeners ya (pronto, para no perder el toque que
    arrancó la app), `currentToken()`, `unregister()`.
- `createAskPolicy({ cooldownDays = 14 })`: cuándo ofrecerlas.
  `decide(permission)` → `'register'` (ya concedido: registrar en silencio),
  `'explain'` (enseña tu hoja explicativa y solo con «Sí» pide el permiso) o
  `'skip'` (denegado, o dijo «Ahora no» hace menos de `cooldownDays`).
  `declined()` / `reset()`.
- `routeFromData(data, ['/event/', '/tabs/'])`: la ruta interna de
  `data.route` si empieza por un prefijo permitido; si no, `null`.

### `@jesusvaros/app-kit/push/supabase`
- `createSupabasePushTokens({ supabase, rpc: { upsert, remove } })` o
  `({ supabase, table, userColumn = 'profile_id' })`:
  `upsertDeviceToken({ platform, token, appVersion, locale, timezone })` y
  `removeDeviceToken(token)` (antes de cerrar sesión: RLS necesita la sesión).
  Con `rpc` las funciones reciben `p_token, p_platform, p_app_version,
  p_locale, p_timezone` y `p_token`; mejor que la tabla porque reasignan un
  token que cambia de cuenta (móvil compartido).
- `deviceContext()`: `{ locale, timezone }` del dispositivo.

## Ejemplo

```ts
import { createNativeSignIn } from '@jesusvaros/app-kit/auth';
import { createSupabaseAuth } from '@jesusvaros/app-kit/auth/supabase';
import { Browser } from '@capacitor/browser';

export const auth = createSupabaseAuth({
  supabase,
  url: import.meta.env.VITE_SUPABASE_URL,
  publishableKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  native: createNativeSignIn({
    google: { webClientId: import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID, iosClientId: import.meta.env.VITE_GOOGLE_IOS_CLIENT_ID },
    apple: { enabled: true, bundleId: 'com.example.app' },
  }),
  appCallbackUrl: 'com.example.app://auth/callback',
  openInAppBrowser: url => Browser.open({ url, presentationStyle: 'popover' }),
});
```

### Push

```ts
import { createAskPolicy, createPush, routeFromData } from '@jesusvaros/app-kit/push';
import { createSupabasePushTokens, deviceContext } from '@jesusvaros/app-kit/push/supabase';

export const push = createPush({
  registerOn: ['android'],
  channels: [{ id: 'conciertos', name: 'Conciertos', importance: 4 }],
});
const tokens = createSupabasePushTokens({ supabase, rpc: { upsert: 'register_push_device', remove: 'unregister_push_device' } });
const policy = createAskPolicy({ cooldownDays: 14 });

// Tras una acción que lo justifique (no al abrir la app):
switch (policy.decide(await push.getPermissionState())) {
  case 'register': await save(await push.register()); break;
  case 'explain': showExplainer(); break; // «Sí» → requestPermissionWhenUseful() → register()
}
const save = (token: string) => tokens.upsertDeviceToken({ platform: push.platform(), token, ...deviceContext() });

push.onToken(({ token }) => void save(token));
push.onTapped(message => {
  const route = routeFromData(message.data, ['/event/', '/tabs/']);
  if (route) navigate(route);
});
```

En Android hace falta Firebase (`google-services.json` y el plugin de Gradle).
El icono pequeño y el color por defecto de FCM van en el `AndroidManifest.xml`
(`com.google.firebase.messaging.default_notification_icon` / `_color` /
`_channel_id`).

## En cada app

Dependencias del login: `@capacitor/core`, `@capacitor/app`, `@capgo/capacitor-social-login`
(≥ 8.7.5) y `@supabase/supabase-js`. En `capacitor.config.ts`:

```ts
plugins: { SocialLogin: { providers: { google: true, apple: true, facebook: false, twitter: false } } }
```

Apple nativo en iOS necesita el entitlement `com.apple.developer.applesignin`.
Google en iOS necesita el «iOS URL scheme» del cliente iOS en `Info.plist`.

## Publicar una versión

```sh
# sube la versión en package.json
npm run release          # typecheck + tests + build a dist/
git add -A && git commit -m "vX.Y.Z" && git tag vX.Y.Z
git push && git push origin vX.Y.Z   # el tag ligero no viaja con --follow-tags
```

Cada app decide cuándo actualizar cambiando el tag en su `package.json`.

## Licencia

MIT
