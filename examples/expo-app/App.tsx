// Chai & Co's mobile app: sign up, then dpdp-kit's consent request with the notice, then the
// privacy centre, all from dpdp-kit/react-native. It talks to the Next.js example's API with a
// Bearer token, as a real app would with its own sign-in.
import { ConsentNotice, DpdpProvider, PrivacyCentre } from "dpdp-kit/react-native";
import { StatusBar } from "expo-status-bar";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

/** The Next.js example (examples/next-app). The iOS Simulator reaches your Mac as localhost; the Android emulator as 10.0.2.2. */
const API = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3103";

type Screen = { name: "sign-up" } | { name: "consent"; token: string } | { name: "privacy"; token: string };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "sign-up" });
  const token = screen.name === "sign-up" ? undefined : screen.token;
  // The client sends the token with every call; the server's `subject` reads it.
  const options = useMemo(() => ({ base: `${API}/privacy`, headers: () => ({ authorization: `Bearer ${token ?? ""}` }) }), [token]);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.app}>
        <StatusBar style="auto" />
        <Text style={styles.brand} accessibilityRole="header">
          Chai &amp; Co
        </Text>
        {screen.name === "sign-up" ? (
          <SignUp onSignedUp={(id) => setScreen({ name: "consent", token: id })} />
        ) : (
          <DpdpProvider key={screen.token} options={options}>
            {screen.name === "consent" ? (
              <ConsentNotice theme="auto" onDone={() => setScreen({ name: "privacy", token: screen.token })} />
            ) : (
              <PrivacyCentre theme="auto" />
            )}
          </DpdpProvider>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function SignUp({ onSignedUp }: { onSignedUp(id: string): void }) {
  const [form, setForm] = useState({ name: "", phone: "", email: "" });
  const [error, setError] = useState("");
  async function submit() {
    setError("");
    try {
      const res = await fetch(`${API}/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      if (!res.ok) throw new Error(String(res.status));
      onSignedUp((await res.json()).id); // the demo's token is the user's id; use your own sign-in
    } catch {
      setError(`Couldn't reach ${API}. Is the Next.js example running?`);
    }
  }
  const field = (key: keyof typeof form, label: string, extra: object = {}) => (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} style={styles.input} value={form[key]} onChangeText={(v) => setForm({ ...form, [key]: v })} {...extra} />
    </View>
  );
  return (
    <View style={styles.signUp}>
      <Text style={styles.title} accessibilityRole="header">
        Create your account
      </Text>
      {field("name", "Name", { autoComplete: "name" })}
      {field("phone", "Mobile number", { keyboardType: "phone-pad", autoComplete: "tel" })}
      {field("email", "Email", { keyboardType: "email-address", autoCapitalize: "none", autoComplete: "email" })}
      <Pressable accessibilityRole="button" style={styles.button} onPress={submit}>
        <Text style={styles.buttonText}>Create account</Text>
      </Pressable>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: "#fbfaf7" },
  brand: { fontSize: 18, fontWeight: "700", paddingHorizontal: 16, paddingTop: 12, color: "#1f1d1a" },
  signUp: { padding: 16, gap: 12 },
  title: { fontSize: 24, fontWeight: "700", color: "#1f1d1a" },
  field: { gap: 4 },
  label: { fontSize: 14, fontWeight: "600", color: "#1f1d1a" },
  input: { borderWidth: 1, borderColor: "#d9d4cb", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12, fontSize: 16, backgroundColor: "#fff" },
  button: { alignSelf: "flex-start", backgroundColor: "#b4532a", borderRadius: 999, paddingVertical: 12, paddingHorizontal: 20 },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 16 },
  error: { color: "#b42318" },
});
