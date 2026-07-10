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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

/** Forced-open dropdown so screenshots capture the composed surface. */
export const DropdownOpen: Story = () => (
  <Frame>
    <div style={{ height: 340 }}>
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" data-state="open">
            Session actions
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Session</DropdownMenuLabel>
          <DropdownMenuItem icon={<IconPencil size={14} />} hint="⌘R">
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem icon={<IconFile size={14} />} hint="⌘E">
            Export transcript
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={<IconTerminal size={14} />}
            description="Runs commands without confirmation prompts"
          >
            Full access
          </DropdownMenuItem>
          <DropdownMenuItem disabled>Archive (soon)</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem danger>Delete session</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </Frame>
);

export const SelectOpen: Story = () => (
  <Frame>
    <div style={{ height: 300 }}>
      <Select open value="q4">
        <SelectTrigger style={{ minWidth: 220 }} />
        <SelectContent>
          <SelectItem value="q4" description="4-bit, 16.4 GB — recommended">
            Q4_K_M
          </SelectItem>
          <SelectItem value="q5" description="5-bit, 19.2 GB">
            Q5_K_M
          </SelectItem>
          <SelectItem value="q8" description="8-bit, 28.9 GB — needs 32GB RAM">
            Q8_0
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  </Frame>
);

/** Static row anatomy sheet (same .pd-menu family the context menu uses). */
export const RowAnatomy: Story = () => (
  <Frame>
    <Row label="menu surface + row states (static)">
      <div className="pd-menu" style={{ position: 'relative', minWidth: 240 }}>
        <div className="pd-menu-label">Section label</div>
        <div className="pd-menu-item">Resting row</div>
        <div className="pd-menu-item" data-highlighted="">
          Highlighted row
        </div>
        <div className="pd-menu-item">
          Row with hint<span className="pd-menu-hint">⌘K</span>
        </div>
        <div className="pd-menu-item" data-disabled="">
          Disabled row
        </div>
        <div className="pd-menu-separator" />
        <div className="pd-menu-item pd-menu-item--danger">Destructive row</div>
      </div>
    </Row>
  </Frame>
);
