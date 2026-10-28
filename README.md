# YouTube Channel Analytics

A single page dashboard for the public videos on your YouTube channel. The Vite + React + TypeScript frontend calls a small Express backend; the backend keeps the YouTube API key out of browser code. Excel exports are generated in the browser with ExcelJS.

## Run locally

1. Install Node.js 20 or later.
2. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project, enable **YouTube Data API v3**, and create an API key under **APIs & Services → Credentials**. Restrict the key to YouTube Data API v3. The key is used only by the Express server.
3. Configure the OAuth consent screen in Google Cloud Console and create an OAuth 2.0 client with application type **Desktop app**. This installed-app flow uses the system browser, a loopback callback, and PKCE. The token endpoint treats the client secret as optional for desktop clients; this backend can pass it when configured if the token endpoint requires it.
4. Copy `.env.example` to `.env` and set the API key and public OAuth client ID:

   ```dotenv
   YOUTUBE_API_KEY=your_actual_key
   GOOGLE_OAUTH_CLIENT_ID=your_desktop_client_id.apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=your_client_secret_if_required
   PORT=3001
   ```

   Keep `.env` private; it is ignored by Git. `GOOGLE_OAUTH_CLIENT_SECRET` is read only by the backend and is never included in the renderer or logs. A desktop OAuth client secret is not confidential and must not be treated as a security boundary.
5. Install dependencies and start the app:

   ```sh
   npm install
   npm run dev
   ```

   Open the Vite URL printed in the terminal (normally http://localhost:5173). The Express API runs on port 3001 and Vite proxies `/api` requests to it.

For a production build, run `npm run build`, then set `NODE_ENV=production` and run `npm start`; Express serves the built frontend and API from the same origin.

## Build the Windows installer

Run `npm run dist:win` from Windows. The NSIS installer is written to `release/MyYoutubeRecord Setup.exe`. It installs a standalone Electron app with the built frontend and bundled Express backend; Node.js and a manually started server are not required on the target computer.

The installer intentionally does not include `.env` or any API key. After installation, create `%APPDATA%\MyYoutubeRecord\.env` with your private settings:

```dotenv
YOUTUBE_API_KEY=your_actual_key
GOOGLE_OAUTH_CLIENT_ID=your_desktop_client_id.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=your_client_secret_if_required
```

The app reads this file when it starts. Add `GOOGLE_OAUTH_CLIENT_SECRET` only if your token exchange requires it; it is used by the backend only. Keep the API key private and restrict it to YouTube Data API v3. The installer build excludes `.env`, source files, and development dependencies.

On the first launch for a Windows profile, MyYoutubeRecord opens Google sign-in in the system browser. It lists the YouTube channels returned for the authenticated account, displays their names and thumbnails, and requires a verified Google email before setup can be saved. Choose a channel and select **Go to Dashboard** to finish setup. OAuth tokens are used only for this ownership check and are discarded. The app stores the selected channel in `%APPDATA%\MyYoutubeRecord\setup.json`; future launches open the existing dashboard without repeating Google verification. Existing profiles that already have a scrypt password hash retain it and continue using it for channel reset. New passwordless profiles verify the same Google account again before a confirmed reset.

For the installed app, add `YOUTUBE_API_KEY` and `GOOGLE_OAUTH_CLIENT_ID` to `%APPDATA%\MyYoutubeRecord\.env`. In Google OAuth testing mode, only accounts listed under **Google Cloud Console → Google Auth Platform → Audience → Test users** can sign in. Add each account there, or publish the app and complete Google's verification so other accounts can use it. The app already allows selecting a different Google account at sign-in and then lists channels accessible to that account. A password is not requested for Google sign-in; existing passwords apply only to the older channel-reset flow.

Use **Logout** in the dashboard header to sign out for the current Windows profile. The saved setup and `.env` stay in place. On the next launch or after logout, sign in with Google again, choose any channel accessible to that account, and select **Go to Dashboard**. The selected channel and verified Google identity are then saved for that profile.

To switch channels, use **Change channel** in the dashboard, confirm the reset, enter the setup password if the profile was configured by an older version, or verify the same Google account for a new passwordless profile, and type `RESET`. This removes only `setup.json`; the API configuration, exports, and other files remain in place. Installing an updated app does not clear this file.

## Data and limitations

- The backend reads the channel's uploads playlist and follows every `nextPageToken`, then fetches video details in batches of up to 50. Refresh re-fetches the data in place.
- A standard API key can read public channel/video data only. The uploads playlist therefore contains public videos visible to the API. Private videos and account-only metrics require OAuth access and cannot be discovered for an arbitrary channel with an API key.
- The table shows `N/A` when YouTube omits an individual video's public statistic, and `Unavailable` if a playlist item cannot be resolved to current video details. Public views, likes, comments, and duration come from YouTube Data API v3.
- The Data API does not return a video's last-modified timestamp. “Last Updated” is the time this dashboard fetched that row; the channel header shows the same last-sync time.
- Subscriber counts follow YouTube's public/rounded reporting rules. OAuth is used once to verify channel ownership during setup; public metrics do not require an OAuth access token after setup. Add an authorized Analytics API flow only if you later need account-level reports such as watch time or impressions.
- Video counts and playlist pagination consume YouTube API quota. For a very large catalog, confirm the project's quota in Google Cloud Console.
