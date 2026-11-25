# @checkin/component-ui

The client kit library pages and app pages load and write through: `useLoad`,
`api()`, `HttpError`, `LoadError`, `Pager`, the viewer context, and
`showSuccess` / `showError` / `showWarning`. App pages use it except the files
on `rawFetchExemptions` in the root `eslint.config.mjs`, which call `fetch`
directly. The rules for using it are in
`docs/conventions.md` ("A library's pages share one client kit"). This file
describes how the kit behaves.

## Binding

Each library binds its route base once. The app binds `/api`, and a path that
already starts with `/api/` is used as given.

```ts
export const { api, useLoad } = createClient("/api/expense");
```

`swr` is a dependency of this package alone. No page imports it.

## How a load behaves

`useLoad(path, options?)` returns `data`, `error`, `loading`, `retrying`,
`status`, `resting`, `answeredAt` and `reload`.

| Server says | Behaviour |
|---|---|
| Network failure or 5xx | Retries after 2s, 4s, 8s and 16s, five attempts in all, including in a hidden or offline tab. While a retry is pending, `retrying` is true, `error` is null and `loading` is false. After the last attempt, `error` is set |
| 401 | No retry. Calls the `ViewerProvider`'s `onSessionExpired`, unless the load passes `expireOn401: false`. The app's handler does a full page load of `/` unless already there |
| 403 | No retry. `status` is 403, so the page can show access denied in place of its content |
| 404, 400, other 4xx | No retry. `error` carries the route's own words |
| 204 | `resting` is true and `data` keeps the last answer that had a body |
| 200 with a non-JSON body | No retry. `error` is set |

`loading` covers only the first answer for a path. A page that shows a spinner
until it has data checks `loading || (retrying && !data)`.

The SWR settings are fixed inside `useLoad`, not in a root `SWRConfig`, so a
page rendered in a test or outside the host behaves the same:
`revalidateOnFocus: false`, `revalidateOnReconnect: true` (unless the load
passes `reconnect: false`), and a five-second dedupe window.

## Options

| Option | Effect |
|---|---|
| `retry: false` | No retries. For a read that is rate limited or costly per attempt |
| `keepPrevious: true` | Keeps the last rows while the next page or search loads. For lists whose rows act on their own id. It never keeps an empty list, and kept rows end when the cache is emptied |
| `expireOn401: false` | A 401 does not end the session. For a read mounted on every page, since routes also answer 401 to a signed-in person who is denied |
| `reconnect: false` | No re-read when the browser reconnects |
| `skipWriteReload: true` | Writes elsewhere do not re-read this load; its own `reload()` still does. With `reconnect: false`, for a read that logs a view or wakes a sleeping database |
| `headers` | Sent on every read of this load, and part of its cache key, so a signed answer never reaches an unsigned reader |
| `stampAnswers: true` | Reports `answeredAt` and re-renders on every answer, even one identical to the last |

## What the cache does

- **The key is the resolved URL**, plus any `headers`. The cache is shared by
  every library, and two libraries can both have a `/settings`.
- **An empty path still loads**, as the library's base URL. Only `null` skips.
- **A new path starts at null**, so one parent's rows never show with another's
  buttons. `keepPrevious` is the opt-in for pagers and search boxes.
- **A person's data ends with them.** When the viewer's id changes from one
  person to another or to nobody, `ViewerProvider` empties the cache before
  paint. A move from null to a person does not, since null also means the
  session is still loading.
- **Tests share a cache.** The app's `jest.setup.js` and this package's
  `testSetup.ts` empty it after each test.

## Writes

Writes are plain `api()` calls. **A successful non-GET through `request`
re-reads every cached load**: mounted loads at once, the rest when next opened,
even inside the dedupe window. Loads with `skipWriteReload` are left out.

A loop of writes passes `invalidate: false` on each and calls
`invalidateLoads()` once when it ends. A write made with a raw `fetch` does not
re-read anything.

Retries and re-reads assume a GET does not change business state.
