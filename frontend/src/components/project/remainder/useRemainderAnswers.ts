// Состояние разбора остатка в окне ввоза: резолюции споров содержимого и ответы на
// остальные вопросы — у создания проекта и у догрузки архивов это была дословная
// копия (аудит F-16). Вопросы — производное от свежего превью, а не состояние.
import { useMemo, useState } from "react";
import type { FamilyConflictOut, RemainderOut } from "../../../types";
import { buildQuestions, pruneAnswers } from "./questions";
import type { Answers, Question, Resolutions } from "./questions";
import type { QuestionMode } from "./questionText";

// Чем превью кормит разбор: споры семей и остаток слияния.
interface RemainderSource {
  family_conflicts: FamilyConflictOut[];
  remainder: RemainderOut;
}

export function useRemainderAnswers(
  // Свежее превью ТЕКУЩИХ входов; null — его нет (грузится, устарело, входов нет).
  fresh: RemainderSource | null,
  // Окно разбора: меняет одну сноску (4.3) — «после догрузки» вместо «после создания».
  mode?: QuestionMode,
): {
  questions: Question[];
  answers: Answers;
  setAnswers: (next: Answers | ((cur: Answers) => Answers)) => void;
  resolutions: Resolutions;
  setResolutions: (next: Resolutions | ((cur: Resolutions) => Resolutions)) => void;
} {
  const [resolutions, setResolutions] = useState<Resolutions>({});
  const [answers, setAnswers] = useState<Answers>({});

  // Резолюции ПЕРЕЖИВАЮТ перезапрос превью (в том числе после 409): id спора
  // стабилен, пока состав входов и живое знание те же. Протухшие (спора больше нет)
  // отбрасываем ПРИ РЕНДЕРЕ — паттерн «adjusting state when props change», а не
  // зеркалящим эффектом.
  const conflicts = fresh?.family_conflicts;
  if (conflicts && Object.keys(resolutions).some((id) => !conflicts.some((c) => c.id === id))) {
    setResolutions(Object.fromEntries(
      Object.entries(resolutions).filter(([id]) => conflicts.some((c) => c.id === id)),
    ));
  }

  const questions = useMemo(
    () => (fresh === null ? [] : buildQuestions({
      family_conflicts: fresh.family_conflicts, remainder: fresh.remainder, mode,
    })),
    [fresh, mode],
  );
  // Ответы протухают тем же правилом: правка входов пересчитывает превью, и вопроса с
  // этим id может больше не быть. Без протухших pruneAnswers возвращает ту же ссылку,
  // поэтому цикла setState нет.
  if (fresh !== null) {
    const живые = pruneAnswers(answers, questions);
    if (живые !== answers) setAnswers(живые);
  }

  return { questions, answers, setAnswers, resolutions, setResolutions };
}
