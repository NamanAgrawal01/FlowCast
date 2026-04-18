# Deployment Guide

## 1. Create the Firebase project

1. Create a new Firebase project in the Firebase console.
2. Add a Web app to the project.
3. Enable Authentication with Email/Password.
4. Create a Firestore database in production mode.
5. Create a Realtime Database instance.
6. Enable Cloud Functions and Firebase Hosting.

## 2. Local config

Populate the Firebase config placeholders in:

- [web/public/config.example.js](/C:/Users/naman/OneDrive/Documents/New%20project%202/web/public/config.example.js)
- [agent/.env.example](/C:/Users/naman/OneDrive/Documents/New%20project%202/agent/.env.example)

Suggested values:

- `FIREBASE_API_KEY`
- `FIREBASE_AUTH_DOMAIN`
- `FIREBASE_DATABASE_URL`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_STORAGE_BUCKET`
- `FIREBASE_MESSAGING_SENDER_ID`
- `FIREBASE_APP_ID`
- `FIREBASE_FUNCTIONS_REGION`

## 3. Install dependencies

From the repo root:

```bash
npm run install:all
```

## 4. Initialize Firebase CLI

```bash
npm install -g firebase-tools
firebase login
firebase use --add
```

## 5. Deploy rules, functions, and hosting

```bash
firebase deploy --only firestore,database,functions,hosting
```

If Firebase asks for a billing-enabled project to deploy Functions, that is a platform requirement rather than an application requirement. The app itself is designed for low-cost / free-tier usage once deployed, but secure credential-minting still depends on Functions.

## 6. Run the laptop agent

```bash
cd agent
npm start
```

The agent will print a 6-digit pairing code if it has not already been linked.

## 7. Pair and connect

1. Open the Firebase Hosting URL on the mobile browser.
2. Create an account or sign in.
3. Enter the pairing code shown by the agent.
4. Select the newly linked device.
5. Press Connect.

## Production notes

- If your Functions region is not `us-central1`, update the region in both the web config and the agent config.
- For broadest compatibility, keep Firestore, Realtime Database, and Functions in nearby regions.
- Public STUN is free but not universal; add TURN later if you need near-100% internet reachability.
