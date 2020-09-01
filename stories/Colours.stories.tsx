import React from 'react';
import { Story, Meta } from '@storybook/react';
import { Box, Divider, Flex, Heading, Stack, Text } from '@chakra-ui/core';

import theme from '../theme';

export default {
  title: 'Theme/Foundations/Colours',
} as Meta;

type SectionProps = {
  colours: typeof theme.colors.brand | typeof theme.colors.portable;
};
const Section: React.FC<SectionProps> = ({ colours }) => {
  return (
    <Stack spacing={4}>
      {Object.keys(colours).map((key) => {
        const value = colours[key as keyof typeof colours];
        return (
          <Stack key={key} spacing={2}>
            <Flex direction="column">
              <Heading fontSize="14px" fontWeight="bold">
                {key}
              </Heading>
              {typeof value !== 'object' && (
                <Heading fontSize="12px" fontWeight="semibold">
                  {colours[key as keyof typeof colours]}
                </Heading>
              )}
              <Divider marginTop={2} />
            </Flex>
            {typeof value === 'object' ? (
              <Stack isInline spacing={2}>
                {Object.keys(value).map((key2) => {
                  const value2 = value[key2];
                  return (
                    <Stack key={key2} spacing={2}>
                      <Heading
                        fontSize="12px"
                        fontWeight="semibold"
                        textAlign="center"
                      >
                        {value2}
                      </Heading>
                      <Flex
                        alignItems="center"
                        backgroundColor={value2}
                        borderRadius="md"
                        boxShadow="lg"
                        flexShrink={0}
                        fontWeight="bold"
                        height="64px"
                        justifyContent="center"
                        width="64px"
                      >
                        <Text color="white" textShadow="0 0 2px black">
                          {key2}
                        </Text>
                      </Flex>
                    </Stack>
                  );
                })}
              </Stack>
            ) : (
              <Box
                backgroundColor={value}
                borderRadius="md"
                boxShadow="lg"
                height="64px"
                width="64px"
              />
            )}
          </Stack>
        );
      })}
    </Stack>
  );
};

export const Project: Story = () => {
  return <Section colours={theme.colors.brand} />;
};

export const Portable: Story = () => {
  return <Section colours={theme.colors.portable} />;
};