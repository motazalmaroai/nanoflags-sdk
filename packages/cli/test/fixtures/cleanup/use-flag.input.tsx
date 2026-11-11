import { useFlag } from "@nanoflags/sdk/react";

export function Checkout({ user }: { user: User }) {
  const v2 = useFlag("checkout-v2", false);
  const other = useFlag("search-ranking", "relevance-v2");
  return (
    <section data-ranking={other}>
      {v2 && <ExpressPay user={user} />}
      {v2 ? <NewSummary /> : <Summary />}
      {!v2 && <LegacyNotice />}
      <Footer compact={v2} />
    </section>
  );
}

export function Inline() {
  if (useFlag("checkout-v2", false)) {
    return <New />;
  }
  return <Old />;
}

export function Banner() {
  return useFlag("checkout-v2", false, { device: "mobile" }) ? <B2 /> : <B1 />;
}
