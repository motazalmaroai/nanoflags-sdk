export const View = ({ flags }) => <p>{flags?.boolean("kill-switch", true) ? "on" : "off"}</p>;
