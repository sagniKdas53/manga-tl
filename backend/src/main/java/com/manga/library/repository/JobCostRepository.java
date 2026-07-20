package com.manga.library.repository;

import com.manga.library.model.JobCost;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface JobCostRepository extends JpaRepository<JobCost, UUID> {
  List<JobCost> findByImageId(UUID imageId);

  List<JobCost> findByJobId(String jobId);
}
