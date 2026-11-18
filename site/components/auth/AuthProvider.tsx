"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createClient } from "@/lib/supabase";
import type { User } from "@supabase/supabase-js";

type AuthState = {
  user: User | null;
  loading: boolean;
};

const AuthContext = createContext<AuthState>({ user: null, loading: true });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    let authStateFired = false;

    // Get initial session. If onAuthStateChange fires before this resolves,
    // the listener has the most recent state, so we skip the stale response.
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!authStateFired) {
        setUser(user);
        setLoading(false);
      }
    });

    // Listen for auth changes — mark authStateFired so getUser() is ignored
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      authStateFired = true;
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
