# app-kit

Login (y pronto onboarding) compartidos entre las apps Capacitor + Supabase:
**live_space** y **puntada**. La referencia de diseño es Holy Cook, que se lee
pero no se toca.

Cada app sigue siendo única: colores, textos, fotos y pantallas van en la app.
El kit solo pone la mecánica.

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

## En cada app

Dependencias: `@capacitor/core`, `@capacitor/app`, `@capgo/capacitor-social-login`
(≥ 8.7.5) y `@supabase/supabase-js`. En `capacitor.config.ts`:

```ts
plugins: { SocialLogin: { providers: { google: true, apple: true, facebook: false, twitter: false } } }
```

Apple nativo en iOS necesita el entitlement `com.apple.developer.applesignin`.
Google en iOS necesita el «iOS URL scheme» del cliente iOS en `Info.plist`.

## Publicar una versión

El repo es privado y las apps no tienen acceso desde su CI. Por eso cada
versión se empaqueta y se guarda dentro de cada app:

```sh
# sube la versión en package.json, luego:
npm run release -- ~/live_space ~/puntada
# en cada app:
npm install --save-exact ./vendor/jesusvaros-app-kit-X.Y.Z.tgz
```

Cada app decide cuándo actualizar. Haz tag `vX.Y.Z` en este repo.
