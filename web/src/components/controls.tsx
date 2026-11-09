import type { ReactNode } from "react";
import { Checkbox } from "@base-ui/react/checkbox";
import { Popover } from "@base-ui/react/popover";
import { Select } from "@base-ui/react/select";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { timeOfDay } from "../format";
import type { AnchorRef } from "../model";
import { Check as CheckIcon, ChevronDown, Diamond, Settings } from "./icons";

/** Base UI checkbox with an inline label. */
export function CheckField({
  checked,
  onChange,
  children,
  small = false,
  title,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  children: ReactNode;
  small?: boolean;
  title?: string;
}) {
  return (
    <label className={small ? "check small" : "check"} title={title}>
      <Checkbox.Root className="cb" checked={checked} onCheckedChange={(v) => onChange(v)}>
        <Checkbox.Indicator className="cb-ind">
          <CheckIcon size={12} />
        </Checkbox.Indicator>
      </Checkbox.Root>
      {children}
    </label>
  );
}

/** Segmented control: a gray track with a raised white active item. */
export function Segmented<T extends string>({
  value,
  options,
  onPick,
  label,
  className = "",
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; title?: string; attrs?: Record<string, string> }>;
  onPick: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <ToggleGroup className={`seg ${className}`} value={[value]} aria-label={label}>
      {options.map((o) => (
        <Toggle
          key={o.value}
          value={o.value}
          className="seg-item"
          title={o.title}
          onClick={() => onPick(o.value)}
          // Space is the app-wide play/pause key; don't let the group turn it into a click.
          onKeyDown={(e) => e.key === " " && e.preventBaseUIHandler()}
          {...o.attrs}
        >
          {o.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

/** Jump-to-anchor picker. It acts as a command list: the value stays empty, every pick jumps. */
export function AnchorPicker({ anchors, passed, onPick }: { anchors: AnchorRef[]; passed: (a: AnchorRef) => boolean; onPick: (i: number) => void }) {
  return (
    <Select.Root<number> value={null} onValueChange={(v) => v != null && onPick(v)} modal={false}>
      <Select.Trigger className="anchor-pick ctl pill" title="Jump to an anchor ( [ / ] )" aria-label="Jump to anchor">
        <Diamond size={12} className="lead" />
        <span className="ctl-label">Anchors ({anchors.length})</span>
        <Select.Icon className="chev">
          <ChevronDown size={14} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner className="pop-pos anchor-pos" sideOffset={6} align="start" alignItemWithTrigger={false}>
          <Select.Popup className="pop">
            <Select.List className="pop-list">
              {anchors.map((a) => (
                <Select.Item key={a.i} value={a.i} className="pop-item anchor-item" data-anchor={a.i}>
                  <span className="t">{timeOfDay(a.t)}</span>
                  <Select.ItemText className="n">{a.name}</Select.ItemText>
                  {passed(a) ? <CheckIcon size={14} className="played" aria-label="passed" /> : <span className="played" />}
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

export function SpeedSelect({ speeds, value, onChange }: { speeds: number[]; value: number; onChange: (v: number) => void }) {
  const items = speeds.map((s) => ({ value: s, label: `${s}×` }));
  return (
    <Select.Root<number> items={items} value={value} onValueChange={(v) => v != null && onChange(v)} modal={false}>
      <Select.Trigger className="ctl pill speed" title="Speed" aria-label="Playback speed">
        <Select.Value className="ctl-label" />
        <Select.Icon className="chev">
          <ChevronDown size={14} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner className="pop-pos" side="top" sideOffset={6} align="start" alignItemWithTrigger={false}>
          <Select.Popup className="pop">
            <Select.List className="pop-list">
              {items.map((it) => (
                <Select.Item key={it.value} value={it.value} className="pop-item speed-item">
                  <Select.ItemText>{it.label}</Select.ItemText>
                  <Select.ItemIndicator className="ind">
                    <CheckIcon size={14} />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

export function SettingsPopover({ children }: { children: ReactNode }) {
  return (
    <Popover.Root>
      <Popover.Trigger className="icon-btn square menu-btn" title="View options" aria-label="View options">
        <Settings />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="pop-pos" sideOffset={8} align="end">
          <Popover.Popup className="pop menu-body">{children}</Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
