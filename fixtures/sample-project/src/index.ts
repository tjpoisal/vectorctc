import React from "react";
import leftPad from "left-pad";
import { add } from "./util.js";

export function greet(name: string): string {
  const padded = leftPad(name, 8, " ");
  return React.createElement("span", null, `${padded} (${add(1, 2)})`);
}
