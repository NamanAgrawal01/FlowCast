# FlowCast Standalone Backend (Free Hosting)

This is a standalone Express server version of the FlowCast backend. It allows you to run the signaling and device management logic without needing the Firebase Blaze (Paid) plan.

## Deploy to Render (FREE)

1.  Go to [Render.com](https://render.com) and create a new **Web Service**.
2.  Connect your GitHub repository.
3.  Set the **Root Directory** to `server`.
4.  Set the **Build Command** to `npm install`.
5.  Set the **Start Command** to `node index.js`.

### Environment Variables on Render:
1.  **FIREBASE_SERVICE_ACCOUNT**: (Required) Go to Firebase Console > Project Settings > Service Accounts > Generate new private key. Open the JSON file, copy the entire content, and paste it here.
2.  **FIREBASE_DATABASE_URL**: (Required) Your Firebase Realtime Database URL (e.g., `https://your-project-id-default-rtdb.firebaseio.com`).
3.  **PORT**: 3000 (Render will handle this automatically).

## Local Setup

1.  `cd server`
2.  `npm install`
3.  Create a `.env` file with the variables above.
4.  `node index.js`

## Update your Website & Agent
Once deployed, copy your Render URL (e.g., `https://flowcast-backend.onrender.com`) and:
1.  Update `web/public/config.js` -> set `externalApiUrl` to your Render URL.
2.  Update your laptop agent's `.env` -> set `FIREBASE_FUNCTIONS_BASE_URL` to your Render URL.
