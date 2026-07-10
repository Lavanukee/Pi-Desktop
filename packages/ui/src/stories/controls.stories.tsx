import type { Story } from '@ladle/react';
import { useState } from 'react';
import {
  Checkbox,
  SegmentedControl,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

export const Controls: Story = () => {
  const [mode, setMode] = useState('chat');
  return (
    <Frame>
      <Row label="switch (36x20, thumb travel = width - height)">
        <Switch aria-label="Off" />
        <Switch aria-label="On" defaultChecked />
        <Switch aria-label="Disabled" disabled />
        <Switch aria-label="Disabled on" disabled defaultChecked />
        <Switch aria-label="Small" size="sm" defaultChecked />
      </Row>
      <Row label="checkbox (16px, r4)">
        <Checkbox aria-label="Unchecked" />
        <Checkbox aria-label="Checked" defaultChecked />
        <Checkbox aria-label="Disabled" disabled />
        <Checkbox aria-label="Disabled checked" disabled defaultChecked />
      </Row>
      <Row label="segmented control (track + raised pill)">
        <SegmentedControl
          aria-label="Composer mode"
          value={mode}
          onValueChange={setMode}
          options={[
            { value: 'chat', label: 'Chat' },
            { value: 'cowork', label: 'Cowork' },
          ]}
        />
      </Row>
      <Row label="tabs (same segmented family)">
        <Tabs defaultValue="home" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <TabsList aria-label="Product area">
            <TabsTrigger value="home">Home</TabsTrigger>
            <TabsTrigger value="code">Code</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
          <TabsContent value="home">Home panel content.</TabsContent>
          <TabsContent value="code">Code panel content.</TabsContent>
          <TabsContent value="settings">Settings panel content.</TabsContent>
        </Tabs>
      </Row>
    </Frame>
  );
};
