import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  GoogleAuthProvider,
  initializeAuth,
  onAuthStateChanged,
  reauthenticateWithPopup,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
  type UserCredential
} from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? 'content-desk-b9c3d.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'content-desk-b9c3d',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? 'content-desk-b9c3d.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? ''
};

let cachedApp: FirebaseApp | null = null;
let cachedAuth: Auth | null = null;

export function getFirebaseAuth(): Auth {
  if (cachedAuth) return cachedAuth;
  cachedApp = getApps()[0] ?? initializeApp(firebaseConfig);
  // Persistence is configured at init time so click handlers invoke signInWithPopup synchronously with ZERO prior await.
  cachedAuth = initializeAuth(cachedApp, {
    persistence: browserLocalPersistence,
    popupRedirectResolver: browserPopupRedirectResolver
  });
  return cachedAuth;
}

export function isStandaloneMode(): boolean {
  if (typeof window === 'undefined') return false;
  const displayModeStandalone =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches;
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
  return displayModeStandalone || iosStandalone;
}

/**
 * Must be invoked directly inside a user click handler with NO prior await.
 */
export function signInWithGooglePopup(): Promise<UserCredential> {
  const auth = getFirebaseAuth();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return signInWithPopup(auth, provider, browserPopupRedirectResolver);
}

/**
 * Must be invoked directly inside a user click handler with NO prior await.
 * Immediately triggers popup reauthentication and then forces a fresh ID token with updated auth_time.
 */
export function reauthenticateWithGooglePopup(): Promise<string> {
  const auth = getFirebaseAuth();
  const user = auth.currentUser;
  if (!user) {
    return Promise.reject(new Error('로그인된 사용자가 없습니다.'));
  }
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return reauthenticateWithPopup(user, provider, browserPopupRedirectResolver).then((cred) =>
    cred.user.getIdToken(true)
  );
}

export function signOutUser(): Promise<void> {
  return signOut(getFirebaseAuth());
}

export function subscribeAuthState(listener: (user: User | null) => void): () => void {
  return onAuthStateChanged(getFirebaseAuth(), listener);
}

export async function getCurrentIdToken(forceRefresh = false): Promise<string | null> {
  const user = getFirebaseAuth().currentUser;
  if (!user) return null;
  return user.getIdToken(forceRefresh);
}

export function mapAuthPopupError(err: unknown, standalone = isStandaloneMode()): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code ?? '')
      : '';

  if (standalone) {
    return '홈 화면 단독 실행(standalone) 모드에서는 Google 로그인 팝업이 정상 동작하지 않을 수 있습니다. 일반 브라우저 탭(Safari 또는 Chrome)에서 열어 로그인해 주세요.';
  }
  if (code === 'auth/popup-blocked') {
    return '브라우저에서 로그인 팝업이 차단되었습니다. 팝업 차단을 허용한 뒤 다시 시도해 주세요.';
  }
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return 'Google 로그인 창이 닫혔습니다. 다시 버튼을 눌러 로그인해 주세요.';
  }
  if (code === 'auth/unauthorized-domain') {
    return '현재 도메인이 Firebase 승인된 도메인에 등록되지 않았습니다. Firebase 콘솔에서 도메인을 추가해 주세요.';
  }
  return 'Google 로그인 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
}
