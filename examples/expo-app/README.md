# Chai & Co on Expo (React Native)

The shop's mobile app: sign up, then dpdp-kit's consent request with the notice, then the privacy centre, from `dpdp-kit/react-native`. It calls the [Next.js example](../next-app/)'s API with a Bearer token, the way a mobile app calls its own backend.

```bash
# 1. The API: the Next.js example
cd ../next-app && npm install && npm run build && npm start -- -p 3103

# 2. The app, in another terminal
cd ../expo-app && npm install
npm run ios        # iOS Simulator (reaches your Mac as localhost)
npm run android    # Android emulator: EXPO_PUBLIC_API_URL=http://10.0.2.2:3103 npm run android
```

`EXPO_PUBLIC_API_URL` points the app at another server. The demo's token is the user's id; with your own sign-in, send your real token and read it in the server's `subject` (see `../next-app/lib/auth.ts`).
