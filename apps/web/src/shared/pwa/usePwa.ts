/**
 * Connects browser installation and update events to React state.
 * Provides the Install app action and fallback instructions when no prompt is available.
 */
import { useEffect, useState } from "react";
type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};

export function usePwa() {
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null);
  const [installHelp, setInstallHelp] = useState(false);
  const [installed, setInstalled] = useState(
    import.meta.env.MODE === "native" || matchMedia("(display-mode: standalone)").matches,
  );
  const [update, setUpdate] = useState<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    if (import.meta.env.MODE === "native") return;
    const beforeInstall = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as InstallEvent);
    };
    const appInstalled = () => {
      setInstalled(true);
      setInstallHelp(false);
      setInstallEvent(null);
    };
    window.addEventListener("beforeinstallprompt", beforeInstall);
    window.addEventListener("appinstalled", appInstalled);
    const pwaUpdate = (event: Event) =>
      setUpdate((event as CustomEvent<ServiceWorkerRegistration>).detail);
    window.addEventListener("campus-update", pwaUpdate);
    return () => {
      window.removeEventListener("beforeinstallprompt", beforeInstall);
      window.removeEventListener("appinstalled", appInstalled);
      window.removeEventListener("campus-update", pwaUpdate);
    };
  }, []);
  async function install() {
    if (!installEvent) {
      setInstallHelp((value) => !value);
      return;
    }
    await installEvent.prompt();
    await installEvent.userChoice;
    setInstallEvent(null);
  }

  return { installed, installHelp, setInstallHelp, install, update };
}
export type PwaControls = ReturnType<typeof usePwa>;
