import { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { supabase } from './lib/supabase';
import PantallaJuego from './screens/PantallaJuego';
import type { Session } from '@supabase/supabase-js';

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppInterno />
    </GestureHandlerRootView>
  );
}

function AppInterno() {
  const [session, setSession] = useState<Session | null>(null);
  const [cargandoSesion, setCargandoSesion] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setCargandoSesion(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  if (cargandoSesion) {
    return (
      <View style={styles.centrado}>
        <ActivityIndicator size="large" color="#F4B93F" />
      </View>
    );
  }

  if (!session) {
    return <PantallaLogin />;
  }

  return <PantallaJuego session={session} />;
}

function PantallaLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [modoRegistro, setModoRegistro] = useState(false);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enviar = async () => {
    setError(null);
    setCargando(true);

    const { error } = modoRegistro
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });

    setCargando(false);
    if (error) setError(error.message);
  };

  return (
    <KeyboardAvoidingView
      style={styles.contenedor}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.titulo}>Senda Oculta</Text>
      <Text style={styles.subtitulo}>
        {modoRegistro ? 'Crea tu cuenta' : 'Inicia sesión'}
      </Text>

      <TextInput
        style={styles.input}
        placeholder="Email"
        placeholderTextColor="#7E8BA3"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="Contraseña"
        placeholderTextColor="#7E8BA3"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      {error && <Text style={styles.error}>{error}</Text>}

      <TouchableOpacity style={styles.boton} onPress={enviar} disabled={cargando}>
        {cargando ? (
          <ActivityIndicator color="#1D2A38" />
        ) : (
          <Text style={styles.botonTexto}>
            {modoRegistro ? 'Registrarme' : 'Entrar'}
          </Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity onPress={() => setModoRegistro(!modoRegistro)}>
        <Text style={styles.enlace}>
          {modoRegistro
            ? '¿Ya tienes cuenta? Inicia sesión'
            : '¿No tienes cuenta? Regístrate'}
        </Text>
      </TouchableOpacity>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  contenedor: {
    flex: 1,
    backgroundColor: '#141B26',
    justifyContent: 'center',
    padding: 24,
  },
  centrado: {
    flex: 1,
    backgroundColor: '#141B26',
    justifyContent: 'center',
    alignItems: 'center',
  },
  titulo: {
    fontSize: 28,
    fontWeight: '800',
    color: '#F6EFD8',
    textAlign: 'center',
    marginBottom: 4,
  },
  subtitulo: {
    fontSize: 14,
    color: '#7E8BA3',
    textAlign: 'center',
    marginBottom: 24,
  },
  input: {
    backgroundColor: '#1B2536',
    borderRadius: 12,
    padding: 14,
    color: '#F6EFD8',
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#2C394D',
  },
  boton: {
    backgroundColor: '#F4B93F',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  botonTexto: {
    color: '#1D2A38',
    fontWeight: '700',
    fontSize: 15,
  },
  enlace: {
    color: '#7BC96F',
    textAlign: 'center',
    marginTop: 16,
    fontSize: 13,
  },
  error: {
    color: '#E8746A',
    textAlign: 'center',
    marginBottom: 8,
    fontSize: 13,
  },
});