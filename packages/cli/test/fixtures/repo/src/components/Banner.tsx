import { useFlag } from "@nanoflags/sdk/react";

export function Banner() {
  const show = useFlag("old-banner", false);
  const layout = useFlag<{ columns: number }>("layout", { columns: 1 });
  return show ? <div data-columns={layout.columns}>Sale</div> : null;
}
