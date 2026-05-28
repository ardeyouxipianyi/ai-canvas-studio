"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";

export default function SettingsLogsRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/settings#logs");
  }, [router]);

  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <LoaderCircle className="size-5 animate-spin text-stone-400" />
    </div>
  );
}
