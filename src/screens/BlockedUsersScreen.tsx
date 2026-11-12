import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../config/firebase';
import { theme } from '../theme';
import { logger } from '../utils/logger';
import { loadOrgNameMap, profileOrgId, unblockUser, useBlockedUsers } from '../utils/moderation';

interface BlockedProfile {
  name: string;
  organizationName: string;
}

interface BlockedUsersScreenProps {
  navigation?: any;
}

export const BlockedUsersScreen: React.FC<BlockedUsersScreenProps> = () => {
  const { blocked, loading } = useBlockedUsers();
  const [profiles, setProfiles] = useState<Record<string, BlockedProfile>>({});
  const [unblocking, setUnblocking] = useState<string | null>(null);
  const inFlight = useRef<Set<string>>(new Set());
  const mounted = useRef(true);
  const orgNames = useRef<Promise<Map<string, string>> | null>(null);

  const blockedIds = useMemo(() => Array.from(blocked), [blocked]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Load a display name for each blocked uid (once per uid).
  useEffect(() => {
    const missing = blockedIds.filter((id) => !(id in profiles) && !inFlight.current.has(id));
    if (missing.length === 0) return;
    missing.forEach((id) => inFlight.current.add(id));

    (async () => {
      if (!orgNames.current) orgNames.current = loadOrgNameMap();
      const names = await orgNames.current;

      const entries = await Promise.all(
        missing.map(async (id): Promise<[string, BlockedProfile]> => {
          try {
            const snap = await getDoc(doc(db, 'users', id));
            if (!snap.exists()) {
              return [id, { name: 'Deleted account', organizationName: '' }];
            }
            const data = snap.data();
            const orgId = profileOrgId(data);
            return [
              id,
              {
                name: typeof data.name === 'string' && data.name ? data.name : 'Unknown user',
                organizationName: orgId ? names.get(orgId) || '' : '',
              },
            ];
          } catch (error) {
            logger.error('Error loading blocked user:', error);
            return [id, { name: 'Unknown user', organizationName: '' }];
          }
        })
      );

      missing.forEach((id) => inFlight.current.delete(id));
      if (mounted.current) {
        setProfiles((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
      }
    })();
  }, [blockedIds, profiles]);

  const rows = useMemo(
    () =>
      blockedIds
        .map((id) => ({ id, profile: profiles[id] }))
        .sort((a, b) => (a.profile?.name || '').localeCompare(b.profile?.name || '')),
    [blockedIds, profiles]
  );

  const handleUnblock = (id: string, name: string) => {
    Alert.alert(
      `Unblock ${name}?`,
      'You will see their direct messages and resource posts again, and they will be able to send you message requests.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unblock',
          onPress: async () => {
            setUnblocking(id);
            try {
              await unblockUser(id);
            } catch (error) {
              logger.error('Error unblocking user:', error);
              Alert.alert('Could not unblock', 'Something went wrong. Please check your connection and try again.');
            } finally {
              setUnblocking(null);
            }
          },
        },
      ]
    );
  };

  const renderRow = ({ item }: { item: { id: string; profile?: BlockedProfile } }) => {
    const name = item.profile?.name || 'Loading...';
    return (
      <View style={styles.row}>
        <MaterialCommunityIcons name="account-cancel" size={40} color={theme.colors.gray} />
        <View style={styles.rowInfo}>
          <Text style={styles.rowName} numberOfLines={1}>{name}</Text>
          {item.profile?.organizationName ? (
            <Text style={styles.rowOrg} numberOfLines={1}>{item.profile.organizationName}</Text>
          ) : null}
        </View>
        <TouchableOpacity
          style={[styles.unblockButton, unblocking === item.id && styles.unblockButtonDisabled]}
          onPress={() => handleUnblock(item.id, item.profile?.name || 'this user')}
          disabled={unblocking === item.id}
          accessibilityRole="button"
          accessibilityLabel={`Unblock ${name}`}
        >
          {unblocking === item.id ? (
            <ActivityIndicator size="small" color={theme.colors.textPrimary} />
          ) : (
            <Text style={styles.unblockText}>Unblock</Text>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        renderItem={renderRow}
        contentContainerStyle={rows.length === 0 ? styles.emptyContent : styles.listContent}
        ListHeaderComponent={
          rows.length > 0 ? (
            <Text style={styles.intro}>
              You don't see direct messages, message requests or resource posts from people you block, and they
              can't send you new message requests.
            </Text>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.centered}>
            <MaterialCommunityIcons name="account-check-outline" size={64} color={theme.colors.gray} />
            <Text style={styles.emptyTitle}>No blocked users</Text>
            <Text style={styles.emptyText}>
              To block someone, use Block in the user directory, in a conversation or on a resource post.
            </Text>
          </View>
        }
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: theme.spacing.l,
  },
  listContent: {
    padding: theme.spacing.m,
  },
  emptyContent: {
    flexGrow: 1,
  },
  intro: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    lineHeight: 18,
    marginBottom: theme.spacing.m,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.m,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: theme.spacing.s,
  },
  rowInfo: {
    flex: 1,
    marginLeft: theme.spacing.m,
  },
  rowName: {
    fontSize: 16,
    fontWeight: '600',
    color: theme.colors.textPrimary,
  },
  rowOrg: {
    fontSize: 12,
    color: theme.colors.textSecondary,
    marginTop: 2,
  },
  unblockButton: {
    minWidth: 84,
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    marginLeft: theme.spacing.s,
  },
  unblockButtonDisabled: {
    opacity: 0.6,
  },
  unblockText: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.colors.textPrimary,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: theme.colors.textPrimary,
    marginTop: theme.spacing.m,
  },
  emptyText: {
    fontSize: 14,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginTop: theme.spacing.s,
    lineHeight: 20,
  },
});
