import type { Story } from '@ladle/react';
import { useState } from 'react';
import {
  Button,
  Chip,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  IconChat,
  IconFile,
  IconPlus,
  IconSearch,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SidebarRow,
  Tabs,
  TabsList,
  TabsTrigger,
} from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

/**
 * The app-wide one-shot reverse-on-leave hover system. Screenshots capture the
 * resting state; hover live to feel the lift/nudge (claude spring / codex
 * expo-out), which reverses once on leave. Reduced-motion drops the transforms.
 */
export const HoverSystem: Story = () => {
  const [seg, setSeg] = useState('chat');
  return (
    <Frame>
      <Row label="buttons + icon buttons lift on hover, settle on press">
        <Button variant="primary">Primary</Button>
        <Button variant="accent">Accent</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <IconButton aria-label="New">
          <IconPlus />
        </IconButton>
      </Row>
      <Row label="chips lift; inactive segmented tabs pick up a wash">
        <Chip icon={<IconSearch size={14} />}>Search the web</Chip>
        <Chip>Summarize this</Chip>
        <SegmentedControl
          aria-label="Mode"
          value={seg}
          onValueChange={setSeg}
          options={[
            { value: 'chat', label: 'Chat' },
            { value: 'cowork', label: 'Cowork' },
          ]}
        />
        <Tabs defaultValue="home">
          <TabsList>
            <TabsTrigger value="home">Home</TabsTrigger>
            <TabsTrigger value="code">Code</TabsTrigger>
          </TabsList>
        </Tabs>
      </Row>
      <Row label="sidebar rows + menu rows nudge toward the pointer">
        <div
          style={{
            width: 240,
            background: 'var(--pd-bg-sidebar)',
            borderRadius: 8,
            padding: 8,
            boxShadow: 'var(--pd-shadow-hairline)',
          }}
        >
          <SidebarRow icon={<IconChat size={16} />} label="Design the composer" meta="2h" />
          <SidebarRow icon={<IconFile size={16} />} label="Port the engine bridge" selected />
          <SidebarRow icon={<IconSearch size={16} />} label="Investigate token math" meta="1d" />
        </div>
        <div className="pd-menu" style={{ position: 'relative', minWidth: 200 }}>
          <div className="pd-menu-item">Rename</div>
          <div className="pd-menu-item">Duplicate</div>
          <div className="pd-menu-item">Export transcript</div>
        </div>
      </Row>
      <Row label="dropdown + select triggers are .pd-btn, so they lift too">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost">Session actions</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Rename</DropdownMenuItem>
            <DropdownMenuItem>Export</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Select defaultValue="q4">
          <SelectTrigger placeholder="Quant" style={{ minWidth: 160 }} />
          <SelectContent>
            <SelectItem value="q4">Q4_K_M</SelectItem>
            <SelectItem value="q8">Q8_0</SelectItem>
          </SelectContent>
        </Select>
      </Row>
    </Frame>
  );
};
