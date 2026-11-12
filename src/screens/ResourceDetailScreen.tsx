import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { logger } from '../utils/logger';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { theme } from '../theme';
import { useAuth } from '../context/AuthContext';
import { db } from '../config/firebase';
import { doc, getDoc, deleteDoc } from 'firebase/firestore';
import { confirmBlockUser, reportContent } from '../utils/moderation';

const CATEGORY_COLORS: { [key: string]: string } = {
  'First Aid': '#e74c3c',
  'Law Enforcement': '#3498db',
  'Fire Safety': '#e67e22',
  'Active Shooter': '#c0392b',
  'Cybersecurity': '#9b59b6',
  'Training': '#27ae60',
  'Best Practices': '#16a085',
  'Past Incidents': '#95a5a6',
  'Equipment': '#34495e',
  'Other': '#7f8c8d',
};

interface Resource {
  id: string;
  title: string;
  description: string;
  category: string;
  imageUrl?: string;
  organizationId: string;
  organizationName?: string;
  postedBy: string;
  postedByName?: string;
  timestamp: Date;
}

interface ResourceDetailScreenProps {
  navigation: any;
  route: {
    params: {
      resourceId: string;
    };
  };
}

export const ResourceDetailScreen: React.FC<ResourceDetailScreenProps> = ({ navigation, route }) => {
  const { user } = useAuth();
  const { resourceId } = route.params;
  const [resource, setResource] = useState<Resource | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadResource();
  }, [resourceId]);

  const loadResource = async () => {
    try {
      const resourceDoc = await getDoc(doc(db, 'resources', resourceId));
      if (resourceDoc.exists()) {
        const data = resourceDoc.data();
        setResource({
          id: resourceDoc.id,
          title: data.title || '',
          description: data.description || '',
          category: data.category || 'Other',
          imageUrl: data.imageUrl,
          organizationId: data.organizationId || '',
          organizationName: data.organizationName,
          postedBy: data.postedBy || '',
          postedByName: data.postedByName,
          timestamp: data.timestamp?.toDate() || new Date(),
        });
      } else {
        Alert.alert('Error', 'Resource not found');
        navigation.goBack();
      }
    } catch (error) {
      logger.error('Error loading resource:', error);
      Alert.alert('Error', 'Failed to load resource');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = () => {
    Alert.alert(
      'Delete Resource',
      'Are you sure you want to delete this resource? This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteDoc(doc(db, 'resources', resourceId));
              Alert.alert('Success', 'Resource deleted successfully', [
                { text: 'OK', onPress: () => navigation.goBack() },
              ]);
            } catch (error) {
              logger.error('Error deleting resource:', error);
              Alert.alert('Error', 'Failed to delete resource');
            }
          },
        },
      ]
    );
  };

  const formatDate = (date: Date) => {
    const options: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    };
    return date.toLocaleDateString('en-US', options);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (!resource) {
    return null;
  }

  // Mirrors the resources delete rule: the poster, an admin of the post's own org, or a
  // super admin. Posts saved with organizationId '' have no org admin.
  const isPoster = !!user?.id && user.id === resource.postedBy;
  const isOrgAdminOfPost =
    (user?.role === 'admin' || user?.role === 'super_admin') &&
    !!resource.organizationId &&
    !!user?.organizationId &&
    user.organizationId !== 'default-org' &&
    resource.organizationId === user.organizationId;
  const canDelete = isPoster || isOrgAdminOfPost || user?.role === 'super_admin';
  const canReport = !isPoster;

  const handleReport = () => {
    reportContent({
      contentType: 'resource',
      contentId: resource.id,
      reportedUserId: resource.postedBy || undefined,
      reportedUserName: resource.postedByName,
      excerpt: `${resource.title} - ${resource.description}`,
    });
  };

  const handleBlockPoster = () => {
    if (!resource.postedBy) return;
    confirmBlockUser({
      uid: resource.postedBy,
      name: resource.postedByName,
      onBlocked: () => navigation.goBack(),
    });
  };

  const handleMoreActions = () => {
    const buttons: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [
      { text: 'Report', onPress: handleReport },
    ];
    if (resource.postedBy) {
      buttons.push({ text: 'Block poster', style: 'destructive', onPress: handleBlockPoster });
    }
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert('Resource', undefined, buttons);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <MaterialCommunityIcons name="arrow-left" size={28} color={theme.colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Resource Details</Text>
        <View style={styles.headerActions}>
          {canDelete && (
            <TouchableOpacity
              onPress={handleDelete}
              accessibilityRole="button"
              accessibilityLabel="Delete resource"
            >
              <MaterialCommunityIcons name="delete" size={24} color={theme.colors.error} />
            </TouchableOpacity>
          )}
          {canReport && (
            <TouchableOpacity
              onPress={handleMoreActions}
              accessibilityRole="button"
              accessibilityLabel="Report this post or block the poster"
            >
              <MaterialCommunityIcons name="dots-vertical" size={24} color={theme.colors.textPrimary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <ScrollView style={styles.content}>
        {resource.imageUrl && (
          <Image source={{ uri: resource.imageUrl }} style={styles.image} />
        )}

        <View style={styles.detailsContainer}>
          <View
            style={[
              styles.categoryBadge,
              { backgroundColor: CATEGORY_COLORS[resource.category] || CATEGORY_COLORS['Other'] },
            ]}
          >
            <Text style={styles.categoryBadgeText}>{resource.category}</Text>
          </View>

          <Text style={styles.title}>{resource.title}</Text>

          <View style={styles.metaContainer}>
            <View style={styles.metaRow}>
              <MaterialCommunityIcons name="office-building" size={16} color={theme.colors.textSecondary} />
              <Text style={styles.metaText}>{resource.organizationName || 'Unknown Org'}</Text>
            </View>
            <View style={styles.metaRow}>
              <MaterialCommunityIcons name="account" size={16} color={theme.colors.textSecondary} />
              <Text style={styles.metaText}>{resource.postedByName || 'Unknown User'}</Text>
            </View>
            <View style={styles.metaRow}>
              <MaterialCommunityIcons name="clock-outline" size={16} color={theme.colors.textSecondary} />
              <Text style={styles.metaText}>{formatDate(resource.timestamp)}</Text>
            </View>
          </View>

          <View style={styles.divider} />

          <Text style={styles.descriptionTitle}>Description</Text>
          <Text style={styles.description}>{resource.description}</Text>

          {canReport && (
            <TouchableOpacity style={styles.reportLink} onPress={handleMoreActions}>
              <MaterialCommunityIcons name="flag-outline" size={16} color={theme.colors.textSecondary} />
              <Text style={styles.reportLinkText}>Report this post or block the poster</Text>
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: theme.colors.textPrimary,
    flex: 1,
    marginLeft: 16,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    flex: 1,
  },
  image: {
    width: '100%',
    height: 300,
    resizeMode: 'cover',
  },
  detailsContainer: {
    padding: 16,
  },
  categoryBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    marginBottom: 16,
  },
  categoryBadgeText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: theme.colors.textPrimary,
    marginBottom: 16,
  },
  metaContainer: {
    marginBottom: 20,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  metaText: {
    fontSize: 14,
    color: theme.colors.textSecondary,
    marginLeft: 8,
  },
  divider: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginVertical: 20,
  },
  descriptionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: theme.colors.textPrimary,
    marginBottom: 12,
  },
  description: {
    fontSize: 16,
    color: theme.colors.textPrimary,
    lineHeight: 24,
  },
  reportLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 32,
    paddingVertical: 8,
    alignSelf: 'flex-start',
  },
  reportLinkText: {
    fontSize: 14,
    color: theme.colors.textSecondary,
    textDecorationLine: 'underline',
  },
});
