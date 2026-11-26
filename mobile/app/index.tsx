/**
 * 로그인 다음 첫 화면 (임시). me.status 로 무엇을 보여 줄지 고른다 (SFR-022·083).
 * 근무 시작·팀·이송 요청 화면은 다음 작업에서 이 자리에 붙인다.
 */
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../src/auth/AuthProvider';
import { statusMessage } from '../src/auth/statusMessage';
import { color, radius } from '../src/ui/theme';

export default function HomeScreen() {
  const { state } = useAuth();
  if (state.status !== 'signedIn') return null;
  const msg = statusMessage(state.me);
  return (
    <SafeAreaView style={s.safe}>
      <View style={s.card}>
        <Text style={s.title}>{msg.title}</Text>
        <Text style={s.body}>{msg.body}</Text>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, padding: 24, backgroundColor: color.background },
  card: {
    padding: 20,
    borderRadius: radius.lg,
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.border,
  },
  title: { fontSize: 22, fontWeight: '800', color: color.foreground },
  body: { marginTop: 8, fontSize: 15, color: color.muted },
});
