# YouTube Channel Analytics

A single page dashboard for the public videos on your YouTube channel. The Vite + React + TypeScript frontend calls a small Express backend; the backend keeps the YouTube API key out of browser code. Excel exports are generated in the browser with ExcelJS.

## Run locally

1. Install Node.js 20 or later.
2. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project, enable **YouTube Data API v3**, and create an API key under **APIs & Services → Credentials**. Restrict the key to YouTube Data API v3. The key is used only by the Express server.
3. Copy `.env.example` to `.env` and add the key:

   ```dotenv
   YOUTUBE_API_KEY=your_actual_key
   YOUTUBE_CHANNEL_ID=UCdeGyg9ocj-F7Q-r_owLtBg
   PORT=3001
   ```

   Keep `.env` private; it is ignored by Git. Change `YOUTUBE_CHANNEL_ID` if you want to use a different channel.
4. Install dependencies and start the app:

   ```sh
   npm install
   npm run dev
   ```

   Open the Vite URL printed in the terminal (normally http://localhost:5173). The Express API runs on port 3001 and Vite proxies `/api` requests to it.

For a production build, run `npm run build`, then set `NODE_ENV=production` and run `npm start`; Express serves the built frontend and API from the same origin.

## Data and limitations

- The backend reads the channel's uploads playlist and follows every `nextPageToken`, then fetches video details in batches of up to 50. Refresh re-fetches the data in place.
- A standard API key can read public channel/video data only. The uploads playlist therefore contains public videos visible to the API. Private videos and account-only metrics require OAuth access and cannot be discovered for an arbitrary channel with an API key.
- The table shows `N/A` when YouTube omits an individual video's public statistic, and `Unavailable` if a playlist item cannot be resolved to current video details. Public views, likes, comments, and duration come from YouTube Data API v3.
- The Data API does not return a video's last-modified timestamp. “Last Updated” is the time this dashboard fetched that row; the channel header shows the same last-sync time.
- Subscriber counts follow YouTube's public/rounded reporting rules. YouTube Analytics API/OAuth is not needed for the public metrics on this page; add an authorized OAuth flow only if you later require account-level reports such as watch time or impressions.
- Video counts and playlist pagination consume YouTube API quota. For a very large catalog, confirm the project's quota in Google Cloud Console.
