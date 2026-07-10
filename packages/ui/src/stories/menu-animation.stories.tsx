import type { Story } from '@ladle/react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconFile,
  IconPencil,
  IconTerminal,
} from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

function Items() {
  return (
    <>
      <DropdownMenuLabel>Session</DropdownMenuLabel>
      <DropdownMenuItem icon={<IconPencil size={14} />} hint="⌘R">
        Rename
      </DropdownMenuItem>
      <DropdownMenuItem icon={<IconFile size={14} />} hint="⌘E">
        Export transcript
      </DropdownMenuItem>
      <DropdownMenuItem icon={<IconTerminal size={14} />}>Open terminal</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem danger>Delete session</DropdownMenuItem>
    </>
  );
}

/*
 * THEME 6 (round-3): both menus REVEAL from the edge nearest their trigger via a
 * clip-path inset that unrolls the surface in the open direction — a dropdown
 * ([data-side=bottom]) unrolls downward from its top edge, a dropup
 * ([data-side=top]) unrolls upward from its bottom edge. No per-item stagger, so
 * the whole panel reads as one smooth roll rather than an instant pop that then
 * populates top-down. Motion is best seen live in Ladle — the screenshot only
 * confirms the composed surface + placement.
 */

/** Dropdown: opens below the trigger, rolls out downward from the top edge. */
export const Dropdown: Story = () => (
  <Frame>
    <Row label="dropdown (data-side=bottom) — grows downward from its top edge">
      <div style={{ height: 320 }}>
        <DropdownMenu open modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" data-state="open">
              Session actions
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom" avoidCollisions={false}>
            <Items />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Row>
  </Frame>
);

/** Dropup: opens above the trigger, rolls out upward from the bottom edge. */
export const Dropup: Story = () => (
  <Frame>
    <div style={{ height: 320 }} />
    <Row label="dropup (data-side=top) — grows upward from its bottom edge">
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" data-state="open">
            Model options
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" avoidCollisions={false}>
          <Items />
        </DropdownMenuContent>
      </DropdownMenu>
    </Row>
  </Frame>
);
