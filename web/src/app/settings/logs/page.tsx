import { redirect } from "next/navigation";

export default function SettingsLogsRedirectPage() {
  redirect("/settings#logs");
}
