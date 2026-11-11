import { useFlag } from "@nanoflags/sdk/react";

export function Checkout({ user }: { user: User }) {
  const other = useFlag("search-ranking", "relevance-v2");
  return (
    <section data-ranking={other}>
      <ExpressPay user={user} />
      <NewSummary />
      <Footer compact={true} />
    </section>
  );
}

export function Inline() {
  return <New />;
  return <Old />;
}

export function Banner() {
  return <B2 />;
}
